import { Test, TestingModule } from '@nestjs/testing';
import { TelegramService } from './telegram.service';
import { UsersService } from '../users/users.service';
import { AiService } from '../ai/ai.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { CalendarService } from '../calendar/calendar.service';

describe('TelegramService', () => {
  let service: TelegramService;
  let module: TestingModule;

  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://test.ngrok.app/webhook/telegram';
    process.env.BASE_URL = 'https://test.ngrok.app';

    module = await Test.createTestingModule({
      providers: [
        TelegramService,
        { provide: UsersService, useValue: { findByTelegramId: jest.fn(), create: jest.fn(), getTimezone: jest.fn().mockResolvedValue('Asia/Jakarta') } },
        { provide: AiService, useValue: { parseTask: jest.fn() } },
        { provide: SchedulerService, useValue: { findAvailableSlots: jest.fn(), sendRecommendation: jest.fn(), confirmSchedule: jest.fn(), cancelSchedule: jest.fn(), modifySchedule: jest.fn(), hasPendingModify: jest.fn(), resetConversation: jest.fn(), continueModify: jest.fn() } },
        { provide: CalendarService, useValue: { getEvents: jest.fn(), buildTodaySummary: jest.fn(), buildWeekSummary: jest.fn() } },
      ],
    }).compile();

    service = module.get<TelegramService>(TelegramService);
    // Wire lazy schedulerService (normally set in onModuleInit via moduleRef).
    // The mock is already in the DI container.
    (service as any).schedulerService = module.get(SchedulerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('/start resets conversation state', () => {
    it('calls resetConversation (not route to pending/or recommendation)', async () => {
      const users = module.get(UsersService) as any;
      const scheduler = module.get(SchedulerService) as any;
      users.findByTelegramId.mockResolvedValue({ id: 'user-1', timezone: 'Asia/Jakarta' });
      scheduler.resetConversation = jest.fn().mockResolvedValue(undefined);
      // Stub sendText supaya gak nembak API.
      service['handler'] = undefined; // ensure doesn't crash
      service['sendText'] = jest.fn().mockResolvedValue(undefined);

      await service.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, first_name: 'Tester' },
          chat: { id: 999, type: 'private' },
          date: 1752000000,
          text: '/start',
        },
      });

      expect(scheduler.resetConversation).toHaveBeenCalledWith('user-1');
      expect(scheduler.hasPendingModify).not.toHaveBeenCalled();
      expect(scheduler.sendRecommendation).not.toHaveBeenCalled();
    });

    it('clears pending modify before routing a follow-up task', async () => {
      const users = module.get(UsersService) as any;
      const scheduler = module.get(SchedulerService) as any;
      users.findByTelegramId.mockResolvedValue({ id: 'user-1', timezone: 'Asia/Jakarta' });
      // After /start, hasPendingModify false → next text routes to task parsing.
      scheduler.resetConversation = jest.fn().mockResolvedValue(undefined);
      scheduler.hasPendingModify = jest.fn().mockReturnValue(false);
      service['sendText'] = jest.fn().mockResolvedValue(undefined);
      service['sendAction'] = jest.fn().mockResolvedValue(undefined);
      const ai = module.get(AiService) as any;
      ai.parseTask = jest.fn().mockResolvedValue({ intent: 'CREATE_TASK', title: 'Makan' });
      scheduler.findAvailableSlots = jest.fn().mockResolvedValue([{ start: new Date(), end: new Date(), availableMinutes: 60 }]);
      scheduler.sendRecommendation = jest.fn().mockResolvedValue(undefined);

      await service.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 123, first_name: 'Tester' },
          chat: { id: 999, type: 'private' },
          date: 1752000000,
          text: 'gw mau makan jam 13.50',
        },
      });

      // Harus masuk jalur task baru, BUKAN jalur continueModify.
      expect(scheduler.sendRecommendation).toHaveBeenCalled();
      expect(scheduler.continueModify).not.toHaveBeenCalled();
    });
  });
});
