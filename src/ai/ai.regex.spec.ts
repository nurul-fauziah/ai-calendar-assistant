import { AiService } from './ai.service';
import { ConfigService } from '@nestjs/config';
import { format } from 'date-fns-tz';

// Tanggal LOKAL user (Asia/Jakarta) — biar test relatif nggak patah saat hari berganti.
const todayStr = (): string => format(new Date(), 'yyyy-MM-dd', { timeZone: 'Asia/Jakarta' });

// Test only the regex fallback path (no LLM_API_KEY)
describe('AiService regex fallback', () => {
  let service: AiService;

  beforeEach(() => {
    const configService = {
      get: jest.fn(() => undefined), // no LLM_API_KEY
    } as unknown as ConfigService;
    service = new AiService(configService);
  });

  it('parses "belajar Python 2 jam besok"', async () => {
    const result = await service.parseTask('belajar Python 2 jam besok');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.title).toContain('belajar Python');
    expect(result.durationMinutes).toBe(120);
    expect(result.deadline).toBeDefined();
    expect(result.priority).toBeUndefined();
  });

  it('parses "urgent meeting 1.5 jam minggu depan"', async () => {
    const result = await service.parseTask('urgent meeting 1.5 jam minggu depan');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.priority).toBe('URGENT');
    expect(result.durationMinutes).toBe(90);
    expect(result.date).toBeDefined();
  });

  it('parses "meeting 30 menit sore hari"', async () => {
    const result = await service.parseTask('meeting 30 menit sore hari');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.durationMinutes).toBe(30);
    expect(result.preferredTime).toBe('EVENING');
  });

  it('falls back to original text as title when no verb', async () => {
    const result = await service.parseTask('2 jam besok');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.durationMinutes).toBe(120);
    expect(result.date).toBeDefined();
  });

  it('parses recurrence "setiap hari push notification 15 menit"', async () => {
    const result = await service.parseTask('setiap hari push notification 15 menit');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.recurrence).toBe('daily');
    expect(result.durationMinutes).toBe(15);
    expect(result.title).toContain('push notification');
  });

  it('parses "Hari ini jam 11.50 siang bilangin ke dewi mau ikut ngelayat atau ngga"', async () => {
    const result = await service.parseTask('Hari ini jam 11.50 siang bilangin ke dewi mau ikut ngelayat atau ngga');
    expect(result.intent).toBe('CREATE_TASK');
    expect(result.date).toBeDefined();
    // time 11:50, bukan jadi 23:00
    expect(result.preferredMinutes).toBe(11 * 60 + 50);
    expect(result.preferredHour).toBe(11);
    expect(result.durationMinutes).toBeUndefined();
    // waktu/date ke-strip, judul bersih
    expect(result.title).toContain('bilangin');
    expect(result.title).not.toContain('11.50');
    expect(result.title).not.toContain('Hari ini');
    expect(result.title).not.toContain('jam');
  });

  it('supports colon minutes "jam 11:50 siang"', async () => {
    const result = await service.parseTask('jam 11:50 siang rapat');
    expect(result.preferredMinutes).toBe(11 * 60 + 50);
  });

  it('supports bare "11.50"', async () => {
    const result = await service.parseTask('11.50 kerjain tugas');
    expect(result.preferredMinutes).toBe(11 * 60 + 50);
    expect(result.title).toContain('kerjain tugas');
  });

  it('supports "jam 8 pagi" = 08:00', async () => {
    const result = await service.parseTask('jam 8 pagi olahraga');
    expect(result.preferredMinutes).toBe(8 * 60);
  });

  it('supports "jam 8 malam" = 20:00 (bukan 08:00)', async () => {
    const result = await service.parseTask('jam 8 malam nonton');
    expect(result.preferredMinutes).toBe(20 * 60);
  });

  it('does not treat duration "2 jam" as a start time', async () => {
    const result = await service.parseTask('belajar Python 2 jam');
    expect(result.durationMinutes).toBe(120);
    expect(result.preferredMinutes).toBeUndefined();
  });

  it('does not leak numeric decimal "11.50" as duration', async () => {
    // Bare "11.50" bukan durasi 11.5 jam — harus jadi jam mulai.
    const result = await service.parseTask('11.50 ketemu dewi');
    expect(result.preferredMinutes).toBe(11 * 60 + 50);
    expect(result.durationMinutes).toBeUndefined();
  });

  it('does not keep "jam" token in title for duration "1.5 jam"', async () => {
    // "1.5 jam" = durasi 90m; title harus bersih, nggak nyisa "jam".
    const result = await service.parseTask('1.5 jam meeting besok');
    expect(result.durationMinutes).toBe(90);
    expect(result.title).toBe('meeting');
    expect(result.title).not.toContain('jam');
  });

  it('parses "hari ini jam 14.50 harus tidur" → 14:50, no invented duration', async () => {
    const r = await service.parseTask('hari ini jam 14.50 harus tidur');
    expect(r.date).toBeDefined();
    expect(r.preferredMinutes).toBe(14 * 60 + 50);
    expect(r.title).toBe('harus tidur');
    expect(r.durationMinutes).toBeUndefined();
  });

  it('parses "hari ini jam 14:50 harus tidur" → 14:50', async () => {
    const r = await service.parseTask('hari ini jam 14:50 harus tidur');
    expect(r.preferredMinutes).toBe(14 * 60 + 50);
    expect(r.title).toBe('harus tidur');
  });

  it('parses "besok jam 8 pagi belajar" → 08:00', async () => {
    const r = await service.parseTask('besok jam 8 pagi belajar');
    expect(r.preferredMinutes).toBe(8 * 60);
    expect(r.title).toBe('belajar');
  });

  it('parses "besok jam 20.30 meeting" → 20:30', async () => {
    const r = await service.parseTask('besok jam 20.30 meeting');
    expect(r.preferredMinutes).toBe(20 * 60 + 30);
    expect(r.title).toBe('meeting');
  });

  it('parses "tanggal 10 september gw harus ke kampus jam 12"', async () => {
    const r = await service.parseTask('tanggal 10 september gw harus ke kampus jam 12');
    // Explicit calendar date → 2026-09-10 (tahun ini, udah lewat → tahun depan kalau lewat).
    // Hari ini 2026-09-08 → 10 sep masih di depan → 2026.
    expect(r.date).toBe('2026-09-10');
    expect(r.preferredMinutes).toBe(12 * 60);
    expect(r.title).toBe('gw harus ke kampus');
    expect(r.title).not.toContain('tanggal');
    expect(r.title).not.toContain('september');
  });

  it('parses "10 september belajar Python jam 14.30"', async () => {
    const r = await service.parseTask('10 september belajar Python jam 14.30');
    expect(r.date).toBe('2026-09-10');
    expect(r.preferredMinutes).toBe(14 * 60 + 30);
    expect(r.title).toBe('belajar Python');
  });

  it('parses "besok meeting jam 10"', async () => {
    const r = await service.parseTask('besok meeting jam 10');
    expect(r.date).toBeDefined();
    expect(r.date).not.toBe(todayStr()); // besok ≠ hari ini
    expect(r.preferredMinutes).toBe(10 * 60);
    expect(r.title).toBe('meeting');
  });

  it('parses "hari ini makan jam 12"', async () => {
    const r = await service.parseTask('hari ini makan jam 12');
    expect(r.date).toBe(todayStr()); // hari ini
    expect(r.preferredMinutes).toBe(12 * 60);
    expect(r.title).toBe('makan');
  });

  it('parses numeric date "10/09" and "10-09"', async () => {
    const r2 = await service.parseTask('10/09 sprint review');
    expect(r2.date).toBe('2026-09-10');
    const r3 = await service.parseTask('10-09 meeting alok');
    expect(r3.date).toBe('2026-09-10');
  });

  it('parses "lusa" = +2 days, not relative shift of an explicit date', async () => {
    const r = await service.parseTask('lusa ujian');
    expect(r.date).toBeDefined();
    expect(r.title).toBe('ujian');
  });

  describe('recurring tasks', () => {
    it('"setiap senin jam 7 belajar bahasa Jepang 1 jam"', async () => {
      const r = await service.parseTask('setiap senin jam 7 belajar bahasa Jepang 1 jam');
      expect(r.intent).toBe('CREATE_TASK');
      expect(r.recurrence).toBe('weekly');
      expect(r.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0');
      expect(r.recurrenceWeekday).toBe(1); // Senin
      expect(r.preferredMinutes).toBe(7 * 60);
      expect(r.durationMinutes).toBe(60);
      expect(r.title).toBe('belajar bahasa Jepang');
      expect(r.title).not.toContain('setiap');
      expect(r.title).not.toContain('senin');
      expect(r.title).not.toContain('jam');
      expect(r.date).toBeUndefined(); // recurring → no one-off date
    });

    it('"setiap hari jam 10 olahraga"', async () => {
      const r = await service.parseTask('setiap hari jam 10 olahraga');
      expect(r.recurrence).toBe('daily');
      expect(r.recurrenceRule).toBe('FREQ=DAILY;BYHOUR=10;BYMINUTE=0');
      expect(r.preferredMinutes).toBe(10 * 60);
      expect(r.title).toBe('olahraga');
      expect(r.date).toBeUndefined();
    });

    it('"setiap tanggal 1 bayar tagihan"', async () => {
      const r = await service.parseTask('setiap tanggal 1 bayar tagihan');
      expect(r.recurrence).toBe('monthly');
      expect(r.recurrenceRule).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
      expect(r.recurrenceMonthDay).toBe(1);
      expect(r.title).toBe('bayar tagihan');
      expect(r.date).toBeUndefined();
    });

    it('"setiap minggu hari Jumat jam 8 meeting"', async () => {
      const r = await service.parseTask('setiap minggu hari Jumat jam 8 meeting');
      expect(r.recurrence).toBe('weekly');
      expect(r.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=8;BYMINUTE=0');
      expect(r.recurrenceWeekday).toBe(5); // Jumat
      expect(r.preferredMinutes).toBe(8 * 60);
      expect(r.title).toBe('meeting');
      expect(r.title).not.toContain('Jumat');
      expect(r.date).toBeUndefined();
    });

    it('"setiap hari Jumat" = weekly Friday, NOT daily', async () => {
      const r = await service.parseTask('setiap hari Jumat jam 9 olahraga');
      expect(r.recurrence).toBe('weekly'); // bukan daily
      expect(r.recurrenceWeekday).toBe(5);
      expect(r.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0');
      expect(r.title).toBe('olahraga');
    });

    it('metode langkah: "setiap senin jam 7 belajar bahasa Jepang 1 jam" pakai recurrence 1 jam', async () => {
      const r = await service.parseTask('bayar tagihan bulanan');
      expect(r.recurrence).toBe('monthly');
      expect(r.recurrenceRule).toBe('FREQ=MONTHLY');
    });

    it('"setiap rabu jajan jam 15.30" → weekly Wednesday 15:30', async () => {
      const r = await service.parseTask('setiap rabu jajan jam 15.30');
      expect(r.intent).toBe('CREATE_TASK');
      expect(r.recurrence).toBe('weekly');
      expect(r.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=WE;BYHOUR=15;BYMINUTE=30');
      expect(r.recurrenceWeekday).toBe(3); // Rabu
      expect(r.preferredMinutes).toBe(15 * 60 + 30);
      expect(r.title).toBe('jajan');
      expect(r.date).toBeUndefined();
    });

    it('"setiap senin belajar Python jam 07.00" → 07:00 (pagi, strict)', async () => {
      const r = await service.parseTask('setiap senin belajar Python jam 07.00');
      expect(r.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0');
      expect(r.preferredMinutes).toBe(7 * 60);
      expect(r.title).toBe('belajar Python');
    });

    it('"setiap jumat meeting jam 10" → 10:00 Jumat', async () => {
      const r = await service.parseTask('setiap jumat meeting jam 10');
      expect(r.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=FR;BYHOUR=10;BYMINUTE=0');
      expect(r.recurrenceWeekday).toBe(5);
      expect(r.title).toBe('meeting');
    });
  });
});
