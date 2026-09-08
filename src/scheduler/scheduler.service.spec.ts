import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerService } from './scheduler.service';
import { PrismaService } from '../common/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { TelegramService } from '../telegram/telegram.service';
import { TasksService } from '../tasks/tasks.service';
import { AiService } from '../ai/ai.service';
import { ConfigService } from '@nestjs/config';

describe('SchedulerService', () => {
  let service: SchedulerService;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Jakarta' }),
    },
    scheduledTask: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const calendar = {
    getEvents: jest.fn().mockResolvedValue([]),
    createEvent: jest.fn().mockResolvedValue({}),
  };
  const telegram = {
    sendText: jest.fn().mockResolvedValue(undefined),
    sendRecommendation: jest.fn().mockResolvedValue(undefined),
    sendAction: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: PrismaService, useValue: prisma },
        { provide: CalendarService, useValue: calendar },
        { provide: TelegramService, useValue: telegram },
        { provide: TasksService, useValue: { createTask: jest.fn() } },
        { provide: AiService, useValue: { parseTask: jest.fn() } },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('starts search on the requested day (parsed.date), not today', async () => {
    // "besok" => parsed.date = tomorrow. findAvailableSlots harus mulai
    // dari hari itu, bukan hari ini.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    prisma.scheduledTask.findMany.mockResolvedValue([]);

    const slots = await service.findAvailableSlots('user-1', {
      intent: 'CREATE_TASK',
      title: 'Tugas',
      durationMinutes: 60,
      date: tomorrowStr,
    });

    const todayStr = new Date().toISOString().split('T')[0];
    const todaySlots = slots.filter((s) => s.start.toISOString().startsWith(todayStr));
    expect(todaySlots.length).toBe(0);
    expect(slots.length).toBeGreaterThan(0);
  });

  it('does not recommend a slot overlapping an existing busy task', async () => {
    // Satu SCHEDULED task sudah kunci 08:00-09:00 WIB hari ini.
    const now = new Date();
    const dayKey = now.toISOString().split('T')[0];
    const startStr = `${dayKey}T01:00:00.000Z`; // 08:00 WIB
    const endStr = `${dayKey}T02:00:00.000Z`; // 09:00 WIB
    prisma.scheduledTask.findMany.mockResolvedValue([
      { startTime: new Date(startStr), endTime: new Date(endStr) },
    ]);

    const slots = await service.findAvailableSlots('user-1', {
      intent: 'CREATE_TASK',
      title: 'Tugas lain',
      durationMinutes: 60,
    });

    const overlapsBusy = slots.some(
      (s) => s.start < new Date(endStr) && new Date(startStr) < s.end,
    );
    expect(overlapsBusy).toBe(false);
  });

  it('starts slot at the requested precise time (preferredMinutes)', async () => {
    prisma.scheduledTask.findMany.mockResolvedValue([]);
    // preferredMinutes 710 = 11:50 WIB (04:50Z)
    const slots = await service.findAvailableSlots('user-1', {
      intent: 'CREATE_TASK',
      title: 'Rapat',
      durationMinutes: 30,
      preferredMinutes: 11 * 60 + 50,
    });

    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    const local = first.start.getUTCHours() * 60 + first.start.getUTCMinutes();
    // 11:50 WIB = 04:50Z
    expect(local).toBe(4 * 60 + 50);
  });

  it('rejects confirm when another task overlaps that slot', async () => {
    const sched = {
      id: 's1',
      userId: 'user-1',
      status: 'PENDING',
      startTime: new Date('2026-09-08T01:00:00.000Z'),
      endTime: new Date('2026-09-08T02:00:00.000Z'),
      task: { title: 'Tugas', description: '', priority: 'NORMAL' },
    };
    // Simulasi: sudah ada task lain yang kunci slot sama.
    prisma.scheduledTask.findUnique.mockResolvedValue(sched);
    prisma.scheduledTask.findFirst.mockResolvedValue({ id: 'other' });
    // Wire lazy telegramService (biasanya di onModuleInit)
    await service['onModuleInit']();

    await service.confirmSchedule(999, 'user-1', 's1');

    // Harus tolak (nge-sendText), JANGAN update ke SCHEDULED, JANGAN buat event.
    expect(prisma.scheduledTask.update).not.toHaveBeenCalled();
    expect(calendar.createEvent).not.toHaveBeenCalled();
    expect(telegram.sendText).toHaveBeenCalledWith(999, expect.stringContaining('bentrok'));
  });
});