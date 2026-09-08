import { AiService } from './ai.service';
import { ConfigService } from '@nestjs/config';

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
});
