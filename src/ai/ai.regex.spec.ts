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
});
