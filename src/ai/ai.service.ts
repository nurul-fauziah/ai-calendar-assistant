import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ParsedTask, Priority } from './ai.interface';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string;
  private readonly apiUrl: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('LLM_API_KEY') ?? '';
    this.apiUrl = config.get<string>('LLM_API_URL') || 'https://api.openai.com/v1/chat/completions';
  }

  async parseTask(text: string): Promise<ParsedTask> {
    // If LLM configured, use it
    if (this.apiKey) {
      return this.parseWithLLM(text);
    }

    // Fallback: regex-based parser
    return this.parseWithRegex(text);
  }

  private async parseWithLLM(text: string): Promise<ParsedTask> {
    const prompt = [
      'Kamu adalah AI assistant untuk personal calendar. Ekstrak informasi dari teks berikut.',
      'Kamu HARUS merespons dalam format JSON valid saja, tidak ada teks tambahan.',
      'Field yang tersedia:',
      '- intent: "CREATE_TASK" | "RESCHEDULE" | "CANCEL" | "UNKNOWN"',
      '- title: string (nama / judul task)',
      '- durationMinutes: number (durasi dalam menit)',
      '- deadline: "YYYY-MM-DD" (tanggal deadline, gunakan YYYY-MM-DD)',
      '- priority: "LOW" | "NORMAL" | "HIGH" | "URGENT"',
      '- preferredTime: "MORNING" | "AFTERNOON" | "EVENING" | "NIGHT" | null',
      '- date: "YYYY-MM-DD" (tanggal mulai jika ada)',
      '- recurrence: string (misal "daily", "weekly", "monthly") | undefined',
      'Contoh:',
      `{"intent": "CREATE_TASK", "title": "Belajar Java", "durationMinutes": 120, "deadline": "2026-08-20", "priority": "NORMAL", "preferredTime": null}`,
      `Teks: "${text}"`,
      'JSON:',
    ].join('\n');

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 500,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
      );

      const content = response.data.choices[0]?.message?.content?.trim();
      if (content) {
        return JSON.parse(content) as ParsedTask;
      }
    } catch (err) {
      const message = err as Error;
      this.logger.error(`AI parse error: ${message.message}`);
    }

    return { intent: 'UNKNOWN' };
  }

  /**
   * Regex-based fallback parser for common Indonesian natural language.
   * Supports: "belajar Python 2 jam besok", "besok belajar Java 1.5 jam",
   * "meeting minggu depan 30 menit", etc.
   */
  private parseWithRegex(text: string): ParsedTask {
    const lower = text.toLowerCase().trim();

    // Detect recurrence
    let recurrence: string | undefined;
    if (lower.includes('setiap hari') || lower.includes('daily')) {
      recurrence = 'daily';
    } else if (lower.includes('setiap minggu') || lower.includes('weekly') || lower.includes('tiap minggu')) {
      recurrence = 'weekly';
    } else if (lower.includes('setiap bulan') || lower.includes('monthly') || lower.includes('tiap bulan')) {
      recurrence = 'monthly';
    }

    // Parse duration: "2 jam", "1.5 jam", "30 menit", "1 jam 30 menit"
    let durationMinutes = 60;
    const durRegex = /(\d+(?:[\.,]\d+)?)\s*jam(?:\s*(\d+(?:[\.,]\d+)?)\s*menit)?/;
    const durMatch = durRegex.exec(text);
    if (durMatch) {
      const hours = parseFloat(durMatch[1].replace(',', '.'));
      const mins = durMatch[2] ? parseFloat(durMatch[2].replace(',', '.')) : 0;
      durationMinutes = Math.round(hours * 60 + mins);
    } else {
      const minRegex = /(\d+)\s*menit/;
      const minMatch = minRegex.exec(text);
      if (minMatch) {
        durationMinutes = parseInt(minMatch[1], 10);
      }
    }

    // Parse date/deadline
    let deadline: string | undefined;
    let date: string | undefined;
    const today = new Date();

    const dayMap: Record<string, number> = {
      'senin': 1, 'selasa': 2, 'rabu': 3, 'kamis': 4,
      'jumat': 5, 'sabtu': 6, 'minggu': 0,
    };

    // Relative dates
    let targetDate: Date | undefined;

    if (lower.includes('hari ini') || lower.includes('sekarang') || lower.includes('today')) {
      targetDate = new Date(today);
    } else if (lower.includes('besok') || lower.includes('tomorrow')) {
      targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (lower.includes('minggu depan') || lower.includes('next week')) {
      targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + 7);
    } else if (lower.includes('minggu ini')) {
      targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() - today.getDay());
    } else if (lower.includes('bulan depan') || lower.includes('next month')) {
      targetDate = new Date(today);
      targetDate.setMonth(targetDate.getMonth() + 1);
    }

    // Day of week names
    for (const [dayName, dayNum] of Object.entries(dayMap)) {
      const regex = new RegExp(`\\b${dayName}\\b`);
      if (regex.test(lower)) {
        targetDate = new Date(today);
        const diff = (dayNum - today.getDay() + 7) % 7;
        targetDate.setDate(targetDate.getDate() + diff);
        break;
      }
    }

    if (targetDate) {
      const iso = targetDate.toISOString().split('T')[0];
      date = iso;
      deadline = iso;
    }

    // Priority keywords
    let priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined;
    if (lower.includes('urgent') || lower.includes('penting banget') || lower.includes('kritis')) {
      priority = 'URGENT';
    } else if (lower.includes('penting') || lower.includes('high') || lower.includes('darurat')) {
      priority = 'HIGH';
    } else if (lower.includes('rendah') || lower.includes('low') || lower.includes('opsional')) {
      priority = 'LOW';
    }

    // Preferred time
    let preferredTime: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | null = null;
    if (lower.includes('pagi') || lower.includes('morning')) {
      preferredTime = 'MORNING';
    } else if (lower.includes('siang') || lower.includes('afternoon')) {
      preferredTime = 'AFTERNOON';
    } else if (lower.includes('sore') || lower.includes('evening')) {
      preferredTime = 'EVENING';
    } else if (lower.includes('malam') || lower.includes('night')) {
      preferredTime = 'NIGHT';
    }

    // Extract title: strip known keywords, keep remaining as title
    let title = text
      .replace(/\d+[\.,]?\d*\s*jam(?:\s*\d+[\.,]?\d*\s*menit)?/g, '')
      .replace(/\d+\s*menit/g, '')
      .replace(/\b(besok|minggu depan|minggu ini|bulan depan|hari ini|sekarang|tomorrow|next week|next month|today)\b/g, '')
      .replace(/\b(setiap hari|setiap minggu|setiap bulan|daily|weekly|monthly|tiap minggu|tiap bulan)\b/g, '')
      .replace(/\b(urgent|penting|high|low|rendah|opsional|morning|afternoon|evening|night|pagi|siang|sore|malam|kritis|darurat)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title) {
      title = text.trim();
    }

    if (!title || title.length < 2) {
      return { intent: 'UNKNOWN' };
    }

    return {
      intent: 'CREATE_TASK',
      title,
      durationMinutes,
      deadline,
      priority: priority as Priority,
      preferredTime,
      date,
      recurrence,
    };
  }
}
