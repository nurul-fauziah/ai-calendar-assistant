import { Test, TestingModule } from '@nestjs/testing';
import { TelegramService } from './telegram.service';
import { UsersService } from '../users/users.service';
import { AiService } from '../ai/ai.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { CalendarService } from '../calendar/calendar.service';

describe('TelegramService', () => {
  let service: TelegramService;

  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://test.ngrok.app/webhook/telegram';
    process.env.BASE_URL = 'https://test.ngrok.app';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: UsersService, useValue: { findByTelegramId: jest.fn(), create: jest.fn() } },
        { provide: AiService, useValue: { parseTask: jest.fn() } },
        { provide: SchedulerService, useValue: { findAvailableSlots: jest.fn(), sendRecommendation: jest.fn(), confirmSchedule: jest.fn(), cancelSchedule: jest.fn(), modifySchedule: jest.fn() } },
        { provide: CalendarService, useValue: { getEvents: jest.fn(), buildTodaySummary: jest.fn(), buildWeekSummary: jest.fn() } },
      ],
    }).compile();

    service = module.get<TelegramService>(TelegramService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
