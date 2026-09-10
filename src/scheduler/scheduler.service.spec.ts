import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerService } from './scheduler.service';
import { PrismaService } from '../common/prisma.service';
import { CalendarService } from '../calendar/calendar.service';
import { TelegramService } from '../telegram/telegram.service';
import { TasksService } from '../tasks/tasks.service';
import { AiService } from '../ai/ai.service';

describe('SchedulerService', () => {
  let service: SchedulerService;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Jakarta' }),
    },
    scheduledTask: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sched-new', ...data })),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    task: {
      findUnique: jest.fn().mockResolvedValue({ id: 't1' }),
      update: jest.fn(),
    },
  };
  const calendar = {
    getEvents: jest.fn().mockResolvedValue([]),
    createEvent: jest.fn().mockResolvedValue({}),
    checkRecurConflict: jest.fn().mockResolvedValue(false),
  };
  const telegram = {
    sendText: jest.fn().mockResolvedValue(undefined),
    sendRecommendation: jest.fn().mockResolvedValue({ messageId: 100 }),
    sendAction: jest.fn().mockResolvedValue(undefined),
    editMessage: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: PrismaService, useValue: prisma },
        { provide: CalendarService, useValue: calendar },
        { provide: TelegramService, useValue: telegram },
        { provide: TasksService, useValue: { createTask: jest.fn().mockResolvedValue({ id: 't-new', title: 'jajan', durationMinutes: 60 }) } },
        {
          provide: AiService,
          useValue: {
            // Default: parser sukses → CREATE_TASK. Tests spesifik override.
            parseTask: jest.fn().mockResolvedValue({
              intent: 'CREATE_TASK',
              preferredMinutes: 15 * 60 + 50,
            }),
          },
        },
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

  it('preserves exact requested time (14:50) when free', async () => {
    prisma.scheduledTask.findMany.mockResolvedValue([]);
    const slots = await service.findAvailableSlots('user-1', {
      intent: 'CREATE_TASK',
      title: 'harus tidur',
      preferredMinutes: 14 * 60 + 50, // 14:50 WIB
    });

    // Nggak boleh mulai 15:00 — harus 14:50 WIB = 07:50Z
    const first = slots[0];
    const utc = first.start.getUTCHours() * 60 + first.start.getUTCMinutes();
    expect(utc).toBe(7 * 60 + 50);
  });

  it('shifts only when a CONFIRMED (SCHEDULED) task conflicts', async () => {
    // Kunci "sekarang" biar deterministik (11:00 WIB = 04:00Z).
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-08T04:00:00.000Z'));
    try {
      // Busy CONFIRMED mulai TEPAT di 14:50 WIB (06:50Z-07:50Z = 14:50-15:50 WIB)
      const dayKey = '2026-09-08';
      const busyStart = `${dayKey}T06:50:00.000Z`;
      const busyEnd = `${dayKey}T07:50:00.000Z`;
      prisma.scheduledTask.findMany.mockResolvedValue([
        { status: 'SCHEDULED', startTime: new Date(busyStart), endTime: new Date(busyEnd) },
      ]);
      // Default durasi 60 menit — nggak muat di gap 14:40-an, jadi shift ke 15:50.
      const slots = await service.findAvailableSlots('user-1', {
        intent: 'CREATE_TASK',
        title: 'harus tidur',
        preferredMinutes: 14 * 60 + 50,
      });

      // Slot harus bergeser SETELAH busy. 15:50 WIB = 07:50Z = 470 menit.
      const first = slots[0];
      const utc = first.start.getUTCHours() * 60 + first.start.getUTCMinutes();
      expect(utc).toBe(7 * 60 + 50);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does NOT treat unconfirmed PENDING recommendation as busy', async () => {
    // Rekomendasi lama yang belum dikonfirmasi (PENDING) BUKAN blocker —
    // ini akar kenapa dulu saran loncat ke 16:50/19:00: rekomendasi basi
    // ikut dihitung "bentrok".
    const dayKey = new Date().toISOString().split('T')[0];
    const busyStart = `${dayKey}T07:50:00.000Z`;
    const busyEnd = `${dayKey}T08:50:00.000Z`;
    prisma.scheduledTask.findMany.mockResolvedValue([
      { status: 'PENDING', startTime: new Date(busyStart), endTime: new Date(busyEnd) },
    ]);
    const slots = await service.findAvailableSlots('user-1', {
      intent: 'CREATE_TASK',
      title: 'harus tidur',
      durationMinutes: 30,
      preferredMinutes: 14 * 60 + 50,
    });

    const first = slots[0];
    const utc = first.start.getUTCHours() * 60 + first.start.getUTCMinutes();
    expect(utc).toBe(7 * 60 + 50); // 14:50 WIB — nggak ke-block PENDING
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

  // ── Flow regression tests ─────────────────────────────────────────────

  it('/start resets conversation state', async () => {
    // Set pending modify + latestRecommendation sebagai "before" state.
    service['pendingModify'].set('user-1', { schedId: 'old', taskId: 't-old', chatId: 999 });
    service['latestRecommendation'].set('user-1', { schedId: 'old', taskId: 't-old', chatId: 999, messageId: 42 });

    // Wire lazy + jalankan resetConversation.
    prisma.scheduledTask.deleteMany.mockResolvedValue({ count: 2 });
    await service['onModuleInit']();
    await service.resetConversation('user-1');

    expect(service.hasPendingModify('user-1')).toBe(false);
    expect(service['latestRecommendation'].has('user-1')).toBe(false);
    expect(prisma.scheduledTask.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'PENDING' },
    });
  });

  it('preserves 13:50 exactly when free', async () => {
    prisma.scheduledTask.findMany.mockResolvedValue([]);
    // "gw mau makan jam 13.50" → preferredMinutes = 13*60+50 = 830
    const slots = await service.findAvailableSlots('user-1', {
      intent: 'CREATE_TASK',
      title: 'makan',
      preferredMinutes: 13 * 60 + 50,
    });
    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    // 13:50 WIB = 06:50Z = 410 UTC-minutes
    const utcMin = first.start.getUTCHours() * 60 + first.start.getUTCMinutes();
    expect(utcMin).toBe(6 * 60 + 50);
  });

  it('modify edits the same message (editMessage, no extra sendText)', async () => {
    prisma.scheduledTask.findMany.mockResolvedValue([]);
    prisma.scheduledTask.deleteMany.mockResolvedValue({ count: 0 });
    prisma.task.update.mockResolvedValue({});
    // Wire lazy telegramService.
    await service['onModuleInit']();

    // Simulasi rekomendasi awal sudah ada, user klik Modify.
    service['latestRecommendation'].set('user-1', {
      schedId: 'sched-1',
      taskId: 't1',
      chatId: 999,
      messageId: 42,
    });

    prisma.scheduledTask.findUnique.mockResolvedValue({
      id: 'sched-1',
      userId: 'user-1',
      status: 'PENDING',
      startTime: new Date('2026-09-08T06:00:00.000Z'),
      endTime: new Date('2026-09-08T07:00:00.000Z'),
      taskId: 't1',
      task: { title: 'Makan', description: '', priority: 'NORMAL', durationMinutes: 60, deadline: null },
    });

    await service.modifySchedule(999, 'user-1', 'sched-1');

    // Modify harus EDIT pesan rekomendasi asli (id=42), nggak bikin pesan baru.
    expect(telegram.editMessage).toHaveBeenCalledWith(999, 42, expect.stringContaining('Mau diubah apa'));
    // JANGAN sendText — biar 1 thread, nggak nyetak prompt ganda.
    expect(telegram.sendText).not.toHaveBeenCalled();
    expect(service.hasPendingModify('user-1')).toBe(true);
  });

  it('continueModify does not re-ask — edits the same message with new recommendation', async () => {
    prisma.scheduledTask.findMany.mockResolvedValue([]);
    prisma.scheduledTask.deleteMany.mockResolvedValue({ count: 0 });
    prisma.task.update.mockResolvedValue({});
    prisma.task.findUnique.mockResolvedValue({ id: 't1', title: 'Makan' });
    prisma.scheduledTask.create.mockImplementation(({ data }) => Promise.resolve({ id: 'sched-new', ...data }));
    await service['onModuleInit']();

    // Pending modify state — user udah klik Modify, chatId + messageId
    // sudah ada dari rekomendasi awal.
    service['pendingModify'].set('user-1', {
      schedId: 'sched-1',
      taskId: 't1',
      chatId: 999,
      messageId: 42,
    });

    prisma.scheduledTask.findUnique.mockResolvedValue({
      id: 'sched-1',
      userId: 'user-1',
      status: 'PENDING',
      startTime: new Date('2026-09-08T06:00:00.000Z'),
      endTime: new Date('2026-09-08T07:00:00.000Z'),
      taskId: 't1',
      task: { title: 'Makan', description: '', priority: 'NORMAL', durationMinutes: 60, deadline: null },
    });

    // User ketik "pindah jam 15.50" → parser harus kasih preferredMinutes 950.
    await service.continueModify(999, 'user-1', 'pindah jam 15.50');

    // 1. Task di-update (data berganti).
    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Makan' }) }),
    );

    // 2. Slot lama dihapus.
    expect(prisma.scheduledTask.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'sched-1' }) }),
    );

    // 3. Pesan rekomendasi di-EDIT, bukan dikirim baru → 1 thread.
    expect(telegram.editMessage).toHaveBeenCalledWith(
      999, 42, expect.stringContaining('Schedule Recommendation'), expect.anything(),
    );
    // sendText nggak boleh dipanggil (dia nggak nanya "Mau diubah apa?" lagi,
    // dia langsung edit pesan jadi rekomendasi baru).
    expect(telegram.sendText).not.toHaveBeenCalled();

    // 4. pendingModify sudah di-clear — user bisa lanjut task baru.
    expect(service.hasPendingModify('user-1')).toBe(false);
  });

  it('modify "pindah jam 15.50" produces preferredMinutes=950', async () => {
    // Verify parser path: "pindah jam 15.50" → 15*60+50 = 950
    const ai = new AiService({ get: jest.fn(() => undefined) } as any);
    const result = await ai.parseTask('pindah jam 15.50');
    expect(result.preferredMinutes).toBe(15 * 60 + 50);
  });

  describe('recurring occurrence day', () => {
    // "setiap rabu jajan jam 15.30" → preview harus RABU (bukan Kamis)
    // & di 15:30, dihitung dari occurrence pertama RRULE.
    it('findAvailableSlots seeds on the recurrence weekday, not first free slot', async () => {
      jest.useFakeTimers();
      // Kamis 2026-09-10 03:00Z (10:00 WIB), pagi — next Rabu = 2026-09-16.
      jest.setSystemTime(Date.parse('2026-09-10T03:00:00.000Z'));
      try {
        prisma.scheduledTask.findMany.mockResolvedValue([]);
        const slots = await service.findAvailableSlots('user-1', {
          intent: 'CREATE_TASK',
          title: 'jajan',
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=15;BYMINUTE=30',
          preferredMinutes: 15 * 60 + 30,
        });
        expect(slots.length).toBeGreaterThan(0);
        const first = slots[0];
        // Rabu (getDay 3) di zona WIB.
        expect(first.start.getUTCDay()).toBe(3); // Rabu (UTC==WIB offset utk jam segini)
        // 15:30 WIB = 08:30Z = 510.
        const utcMin = first.start.getUTCHours() * 60 + first.start.getUTCMinutes();
        expect(utcMin).toBe(8 * 60 + 30);
      } finally {
        jest.useRealTimers();
      }
    });

    it('first occurrence of weekly "setiap rabu" lands mid-next-week, not same-day-if-zero-diff', async () => {
      // Kamis → next Rabu; kalau "hari ini Rabu & udah lewat", lompat minggu depan.
      jest.useFakeTimers();
      jest.setSystemTime(Date.parse('2026-09-10T03:00:00.000Z')); // Kamis
      try {
        const occ = (service as any).firstOccurrenceForRule(
          'FREQ=WEEKLY;BYDAY=WE;BYHOUR=15;BYMINUTE=30',
          'Asia/Jakarta',
        );
        expect(occ.getUTCDay()).toBe(3); // Rabu
        expect(occ.toISOString().slice(0, 10)).toBe('2026-09-16');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('recurring time clarification flow', () => {
    // User: "setiap kamis jajan" → bot asks time → User: "jam 7"
    // Harus complete task pending dengan title "jajan", recurrence Kamis, jam 07:00.
    it('continues pending recurring task when user provides time', async () => {
      jest.useFakeTimers();
      // Rabu 2026-09-09 03:00Z (10:00 WIB) → next Kamis = 2026-09-10.
      jest.setSystemTime(Date.parse('2026-09-09T03:00:00.000Z'));
      try {
        // Wire lazy telegramService (needed for continueRecurTime to send messages)
        await service['onModuleInit']();
        // Setup: pendingRecurTime already set (simulating first message "setiap kamis jajan")
        service['pendingRecurTime'].set('user-1', {
          chatId: 999,
          taskId: '',
          rrule: 'FREQ=WEEKLY;BYDAY=TH',
          title: 'jajan',
        });
        prisma.scheduledTask.findMany.mockResolvedValue([]);

        // User replies with just the time
        await service.continueRecurTime(999, 'user-1', 'jam 7');

        // Should create task with correct title & recurrence (via TasksService.createTask)
        const tasksService = module.get(TasksService);
        expect(tasksService.createTask).toHaveBeenCalledWith('user-1', expect.objectContaining({
          title: 'jajan',
          recurrenceRule: 'FREQ=WEEKLY;BYDAY=TH;BYHOUR=7;BYMINUTE=0',
        }));

        // Should send recommendation with correct occurrence
        expect(telegram.sendRecommendation).toHaveBeenCalled();
        // pendingRecurTime cleared
        expect(service.hasPendingRecurTime('user-1')).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('parses "jam 7" as 07:00 (strict, not 19:00)', async () => {
      const minutes = (service as any).parseTimeForRecurring('jam 7');
      expect(minutes).toBe(7 * 60);
    });

    it('parses "jam 7 pagi" as 07:00', async () => {
      const minutes = (service as any).parseTimeForRecurring('jam 7 pagi');
      expect(minutes).toBe(7 * 60);
    });

    it('parses "jam 7 malam" as 19:00', async () => {
      const minutes = (service as any).parseTimeForRecurring('jam 7 malam');
      expect(minutes).toBe(19 * 60);
    });

    it('parses "jam 15.30" as 15:30', async () => {
      const minutes = (service as any).parseTimeForRecurring('jam 15.30');
      expect(minutes).toBe(15 * 60 + 30);
    });

    it('parses "jam 3 sore" as 15:00', async () => {
      const minutes = (service as any).parseTimeForRecurring('jam 3 sore');
      expect(minutes).toBe(15 * 60);
    });

    it('parses bare "15.30" as 15:30', async () => {
      const minutes = (service as any).parseTimeForRecurring('15.30');
      expect(minutes).toBe(15 * 60 + 30);
    });

    it('parses bare "07:00" as 07:00', async () => {
      const minutes = (service as any).parseTimeForRecurring('07:00');
      expect(minutes).toBe(7 * 60);
    });

    it('keeps pending state when time is invalid', async () => {
      await service['onModuleInit']();
      service['pendingRecurTime'].set('user-1', {
        chatId: 999,
        taskId: '',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        title: 'jajan',
      });
      await service.continueRecurTime(999, 'user-1', 'bukan jam');
      expect(service.hasPendingRecurTime('user-1')).toBe(true);
      expect(telegram.sendText).toHaveBeenCalledWith(999, expect.stringContaining('Jam mulainya'));
    });

    it('clears pending on "batal"', async () => {
      await service['onModuleInit']();
      service['pendingRecurTime'].set('user-1', {
        chatId: 999,
        taskId: '',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        title: 'jajan',
      });
      await service.continueRecurTime(999, 'user-1', 'batal');
      expect(service.hasPendingRecurTime('user-1')).toBe(false);
      expect(telegram.sendText).toHaveBeenCalledWith(999, 'Oke, jadwal ulang dibatalkan.');
    });
  });
});