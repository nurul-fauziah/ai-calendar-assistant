import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerService } from './scheduler.service';
import { PrismaService } from '../common/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { TelegramService } from '../telegram/telegram.service';
import { TasksService } from '../tasks/tasks.service';

describe('SchedulerService', () => {
  let service: SchedulerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: PrismaService, useValue: { scheduledTask: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), deleteMany: jest.fn() } } },
        { provide: CalendarService, useValue: { getEvents: jest.fn(), createEvent: jest.fn() } },
        { provide: TelegramService, useValue: { sendText: jest.fn(), sendRecommendation: jest.fn(), sendAction: jest.fn() } },
        { provide: TasksService, useValue: { createTask: jest.fn() } },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
