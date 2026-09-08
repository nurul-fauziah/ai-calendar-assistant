import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { format, fromZonedTime, toZonedTime } from 'date-fns-tz';
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

  async parseTask(text: string, timezone?: string): Promise<ParsedTask> {
    // If LLM configured, use it
    if (this.apiKey) {
      return this.parseWithLLM(text, timezone);
    }

    // Fallback: regex-based parser
    return this.parseWithRegex(text, timezone);
  }

  private async parseWithLLM(text: string, timezone?: string): Promise<ParsedTask> {
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
      '- preferredHour: number | null (jam mulai SPESIFIK yang diminta, 0-23. "jam 1 siang" = 13, "jam 9 pagi" = 9, "13:00" = 13. null kalau nggak ada)',
      '- date: "YYYY-MM-DD" (tanggal mulai jika ada)',
      '- recurrence: string (misal "daily", "weekly", "monthly") | undefined',
      'Contoh:',
      `{"intent": "CREATE_TASK", "title": "Belajar Java", "durationMinutes": 120, "deadline": "2026-08-20", "priority": "NORMAL", "preferredTime": null, "preferredHour": null}`,
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
  private parseWithRegex(text: string, timezone?: string): ParsedTask {
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

    // Parse date/deadline. Semua relatif (hari ini/besok/minggu depan) harus
    // dihitung dari tanggal LOKAL user, bukan zona host. Host UTC di malam
    // hari (mis. 05:00 WIB) masih "kemarin" secara UTC → kalau nggak,
    // "besok" salah jadinya hari ini.
    let deadline: string | undefined;
    let date: string | undefined;
    const tz = timezone || 'Asia/Jakarta';
    const todayStr = format(new Date(), 'yyyy-MM-dd', { timeZone: tz });
    const todayWeekday = toZonedTime(new Date(), tz).getDay();

    // Tambah/geser hari pada string tanggal lokal (noon biar aman dari DST).
    const shiftLocal = (mins: number): string =>
      format(
        fromZonedTime(`${todayStr}T12:00:00`, tz).getTime() + mins * 60000,
        'yyyy-MM-dd',
        { timeZone: tz },
      );
    const dayMs = 24 * 60;

    const dayMap: Record<string, number> = {
      'senin': 1, 'selasa': 2, 'rabu': 3, 'kamis': 4,
      'jumat': 5, 'sabtu': 6, 'minggu': 0,
    };

    // Relative dates
    let target: string | undefined;

    if (lower.includes('hari ini') || lower.includes('sekarang') || lower.includes('today')) {
      target = todayStr;
    } else if (lower.includes('besok') || lower.includes('tomorrow')) {
      target = shiftLocal(dayMs);
    } else if (lower.includes('minggu depan') || lower.includes('next week')) {
      target = shiftLocal(7 * dayMs);
    } else if (lower.includes('minggu ini')) {
      target = shiftLocal(-todayWeekday * dayMs);
    } else if (lower.includes('bulan depan') || lower.includes('next month')) {
      target = shiftLocal(30 * dayMs);
    }

    // Day of week names
    if (!target) {
      for (const [dayName, dayNum] of Object.entries(dayMap)) {
        const regex = new RegExp(`\\b${dayName}\\b`);
        if (regex.test(lower)) {
          const diff = (dayNum - todayWeekday + 7) % 7;
          target = todayStr;
          if (diff !== 0) target = shiftLocal(diff * dayMs);
          break;
        }
      }
    }

    if (target) {
      date = target;
      deadline = target;
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

    // Parse jam spesifik yang diminta, mis:
    //   "jam 1" / "jam 1 siang" / "pukul 15" / "13:00" / "jam 1 sore" / "3pm"
    // Periode (pagi/siang/sore/malam) menentukan offset +12 untuk jam 1-11.
    let preferredHour: number | undefined;
    const hourMatch = /(?:\b|pukul\s+|jam\s+)(\d{1,2})(?::(\d{2}))?\s*(pagi|siang|sore|malam)?(?:\b|$)/i.exec(text);
    if (hourMatch && /(jam|pukul|:)/i.test(hourMatch[0])) {
      let h = parseInt(hourMatch[1], 10);
      const period = hourMatch[3];
      if (period === 'siang' || period === 'sore' || period === 'malam') {
        if (h < 12) h += 12;
      } else {
        // "jam 1" / "jam 3" tanpa periode = siang/sore, bukan subuh.
        // Jam 1-7 umumnya selalu PM dalam ucapan sehari-hari.
        if (h >= 1 && h <= 7) h += 12;
      }
      if (h >= 0 && h <= 23) preferredHour = h;
    }

    // Extract title: strip known keywords, keep remaining as title
    let title = text
      .replace(/\d+[\.,]?\d*\s*jam(?:\s*\d+[\.,]?\d*\s*menit)?/g, '')
      .replace(/\d+\s*menit/g, '')
      .replace(/(?:jam|pukul)\s+\d{1,2}(?::\d{2})?\s*(?:pagi|siang|sore|malam)?/gi, '')
      .replace(/\d{1,2}:\d{2}/g, '')
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
      preferredHour,
      date,
      recurrence,
    };
  }
}
