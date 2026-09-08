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
      '- preferredMinutes: number | null (menit mulai presisi, 0-1439. "11.50" = 710, "jam 8 pagi" = 480. null kalau nggak minta jam)',
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

    // Parse duration: "2 jam", "1.5 jam", "30 menit", "1 jam 30 menit".
    // Nur "N jam" (angka sebelum kata jam) = duration. "jam N" = jam mulai,
    // dibedakan di bawah. Kalau user nggak sebut durasi → undefined, biar
    // scheduler default 60 — parser nggak ngarang.
    let durationMinutes: number | undefined;
    const durRegex = /(\d+(?:[\.,]\d+)?)\s*jam(?:\s+(\d+(?:[\.,]\d+)?)\s*menit)?/;
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

    // Tanggal kalender eksplisit. "tanggal 10 september", "10 september",
    // "10/09", "10-09". Diprioritaskan: kalau user sebut tanggal nyata,
    // JANGAN kena offset relatif (besok/minggu ini dst). Tahun diresolusi:
    // kalau tanggal sudah lewat di tahun ini → tahun depan.
    const monthMap: Record<string, number> = {
      januari: 1, february: 2, pebruari: 2, maret: 3, april: 4, mei: 5,
      juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11,
      desember: 12, january: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const buildDateStr = (day: number, month: number): string | undefined => {
      if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
      const [y, m, d] = todayStr.split('-').map(Number);
      let year = y;
      if (month < m || (month === m && day < d)) year += 1;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };

    let target: string | undefined;

    // 1) "tanggal 10 september" / "10 september" — nama bulan
    const monthNameMatch = /\b(?:tanggal\s+)?(\d{1,2})\s+([a-z]+)\b/i.exec(lower);
    if (monthNameMatch && monthMap[monthNameMatch[2].toLowerCase()]) {
      target = buildDateStr(+monthNameMatch[1], monthMap[monthNameMatch[2].toLowerCase()]);
    }

    // 2) "10/09" / "10-09" — numerik (dd/mm gaya Indonesia)
    if (!target) {
      const numDate = /\b(\d{1,2})[\/-](\d{1,2})\b/i.exec(lower);
      if (numDate) {
        target = buildDateStr(+numDate[1], +numDate[2]);
      }
    }

    // Relative dates — HANYA kalau nggak ada tanggal eksplisit.
    if (!target) {
      if (lower.includes('hari ini') || lower.includes('sekarang') || lower.includes('today')) {
        target = todayStr;
      } else if (lower.includes('lusa')) {
        target = shiftLocal(2 * dayMs);
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

    // Parse jam mulai SPESIFIK, presisi menit. Support format:
    //   "jam 1", "jam 1 siang", "pukul 15", "13:00", "11.50", "jam 11.50",
    //   "jam 8 pagi", "jam 8 malam", "18:30"
    // Dipisah dari duration: "2 jam" (angka SEBELUM 'jam') = durasi;
    // "jam 8"/"11:50" = jam mulai. Menit disimpan sebagai preferredMinutes.
    let preferredMinutes: number | undefined;

    const resolveTime = (hRaw: number, mRaw: number | undefined, period?: string): number | undefined => {
      if (hRaw > 24 || (mRaw !== undefined && mRaw >= 60)) return undefined;
      let h = hRaw;
      if (mRaw !== undefined) {
        // Menit eksplisit = jam sudah tertentu. "11.50 siang" = 11:50,
        // "jam 11.50" = 11:50. Nggak usah geser +12.
      } else if (period === 'siang' || period === 'sore' || period === 'malam') {
        // Tanpa menit + periode: "jam 1 siang"=13, "jam 3 sore"=15,
        // "jam 8 malam"=20.
        if (h <= 11) h += 12;
      } else if (h >= 1 && h <= 7) {
        // "jam 1"/"jam 3" tanpa periode & tanpa menit = siang/sore (bukan subuh).
        h += 12;
      }
      return h * 60 + (mRaw || 0);
    };

    // Bentuk 1: diawali "jam"/"pukul" — SELALU jam mulai.
    const prefixMatch = /\b(?:jam|pukul)\s+(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?\s*(pagi|siang|sore|malam)?/i.exec(text);
    if (prefixMatch) {
      preferredMinutes = resolveTime(
        parseInt(prefixMatch[1], 10),
        prefixMatch[2] !== undefined ? parseInt(prefixMatch[2], 10) : undefined,
        prefixMatch[3],
      );
    } else {
      // Bentuk 2: angka dengan pemisah ':' atau '.', "11.50"/"13:00".
      // Bukan durasi: "1.5 jam" punya `.5` tapi diikuti " jam" → skip.
      const bareMatch = /(?<![\d:.])(\d{1,2})\s*[:.]\s*(\d{1,2})(?!\s*(?:jam|pukul))/i.exec(text);
      if (bareMatch) {
        preferredMinutes = resolveTime(
          parseInt(bareMatch[1], 10),
          parseInt(bareMatch[2], 10),
        );
      }
    }

    // Extract title: strip known tokens (waktu, tanggal relatif, durasi,
    // prioritas), sisanya jadi judul.
    let title = text
      // Durasi DULUAN: "1.5 jam", "2 jam", "30 menit". Kalau strip waktu
      // jalan duluan, "1.5" ke-eat jadi durasi "1.5 jam" → sisa "jam".
      .replace(/\b\d+(?:[.,]\d+)?\s*jam(?:\s+\d+[\.,]?\d*\s*menit)?/gi, '')
      .replace(/\b\d+\s*menit/gi, '')
      // Waktu: "jam 8 pagi", "pukul 15.30", "11.50", "13:00", "18:30 siang"
      .replace(/\b(?:jam|pukul)\s+\d{1,2}(?:\s*[:.]\s*\d{1,2})?\s*(?:pagi|siang|sore|malam)?/gi, '')
      .replace(/\b\d{1,2}\s*[:.]\s*\d{1,2}\s*(?:pagi|siang|sore|malam)?/gi, '')
      // Tanggal kalender eksplisit: "tanggal 10 september", "10 september",
      // "10/09", "10-09" — biar nggak nyisa di judul.
      .replace(/\btanggal\s+\d{1,2}\s+[a-z]+\b/gi, '')
      .replace(/\b\d{1,2}\s+[a-z]+\b/gi, '')
      .replace(/\b\d{1,2}[\/-]\d{1,2}\b/gi, '')
      // Tanggal relatif + yang lain
      .replace(/\b(besok|lusa|minggu depan|minggu ini|bulan depan|hari ini|sekarang|tomorrow|next week|next month|today|kemarin)\b/gi, '')
      .replace(/\b(setiap hari|setiap minggu|setiap bulan|daily|weekly|monthly|tiap minggu|tiap bulan)\b/gi, '')
      .replace(/\b(urgent|penting banget|kritis|darurat|penting|high|low|rendah|opsional|morning|afternoon|evening|night|pagi|siang|sore|malam)\b/gi, '')
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
      // preferredHour = preferredMinutes dibagi 60 (buat yang lama2 masih
      // jalan); preferredMinutes = presisi penuh buat scheduler.
      preferredHour: preferredMinutes !== undefined ? Math.floor(preferredMinutes / 60) : undefined,
      preferredMinutes,
      date,
      recurrence,
    };
  }
}
