import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CalendarService } from '../calendar/calendar.service';
import { PrismaService } from '../common/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { TasksService } from '../tasks/tasks.service';
import { ParsedTask, Priority } from '../ai/ai.interface';
import { escapeHtml } from '../common/html-escape';
import { AvailableSlot, ScheduleItem } from './scheduler.interface';
import { addMinutes, endOfDay, format } from 'date-fns';
import { id as idLocale } from 'date-fns/locale/id';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private telegramService: TelegramService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly tasksService: TasksService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    this.telegramService = this.moduleRef.get(TelegramService, { strict: false });
  }

  async findAvailableSlots(
    userId: string,
    parsed: ParsedTask,
  ): Promise<AvailableSlot[]> {
    const { durationMinutes, deadline, preferredTime } = parsed;

    const now = new Date();
    const searchEnd = deadline
      ? new Date(deadline)
      : addMinutes(now, 7 * 24 * 60);

    const [events, dbEvents] = await Promise.all([
      this.calendar.getEvents(userId, now, searchEnd),
      this.prisma.scheduledTask.findMany({
        where: {
          userId,
          status: { not: 'CANCELLED' },
          endTime: { gt: now },
          startTime: { lt: searchEnd },
        },
        select: { startTime: true, endTime: true },
      }),
    ]);

    // Busy = Google Calendar events + task yang sudah punya slot (jangan
    // sampai dua rekomendasi dikasih di waktu yang sama).
    const busy = [
      ...events.map((e) => ({ start: new Date(e.start), end: new Date(e.end) })),
      ...dbEvents.map((e) => ({ start: new Date(e.startTime), end: new Date(e.endTime) })),
    ];

    const slots: AvailableSlot[] = [];
    const current = new Date(now);
    current.setHours(0, 0, 0, 0);

    while (current <= searchEnd) {
      const dayStart = new Date(current);
      const dayEnd = endOfDay(new Date(current));

      const dayEvents = busy
        .filter((e) => e.start <= dayEnd && e.end >= dayStart)
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      const workStart = new Date(dayStart);
      workStart.setHours(8, 0, 0, 0);
      const workEnd = new Date(dayStart);
      workEnd.setHours(22, 0, 0, 0);

      let cursor = new Date(workStart);
      for (const ev of dayEvents) {
        if (ev.start > cursor && ev.start <= workEnd) {
          const gapEnd = ev.start > workEnd ? workEnd : ev.start;
          const gapMinutes = (gapEnd.getTime() - cursor.getTime()) / 60000;
          if (gapMinutes >= (durationMinutes || 30)) {
            slots.push({
              start: new Date(cursor),
              end: gapEnd,
              availableMinutes: gapMinutes,
            });
          }
        }
        if (ev.end > cursor) {
          cursor = ev.end > workEnd ? workEnd : ev.end;
        }
      }

      if (cursor < workEnd) {
        const gapMinutes = (workEnd.getTime() - cursor.getTime()) / 60000;
        if (gapMinutes >= (durationMinutes || 30)) {
          slots.push({
            start: new Date(cursor),
            end: workEnd,
            availableMinutes: gapMinutes,
          });
        }
      }

      current.setDate(current.getDate() + 1);
    }

    if (preferredTime) {
      slots.sort((a, b) => this.scoreByPreference(a, b, preferredTime));
    }

    return slots;
  }

  private scoreByPreference(a: AvailableSlot, b: AvailableSlot, pref: string): number {
    const prefScores: Record<string, (h: number) => number> = {
      MORNING: (h) => (h >= 8 && h <= 12 ? 1 : 0),
      AFTERNOON: (h) => (h > 12 && h <= 15 ? 1 : 0),
      EVENING: (h) => (h > 15 && h <= 19 ? 1 : 0),
      NIGHT: (h) => (h > 19 && h <= 22 ? 1 : 0),
    };
    const scorer = prefScores[pref] || (() => 0);
    return scorer(b.start.getHours()) - scorer(a.start.getHours());
  }

  async sendRecommendation(
    chatId: number,
    userId: string,
    parsed: ParsedTask,
    slots: AvailableSlot[],
  ) {
    const duration = parsed.durationMinutes || 60;
    const selectedSlots = slots.slice(0, 3).filter((s) => s.availableMinutes >= duration);

    if (selectedSlots.length === 0) {
      return this.telegramService.sendText(
        chatId,
        'Gue nggak nemu slot yang cukup panjang. Kurangin durasi atau perpanjang deadline?',
      );
    }

    let remaining = duration;
    const items: ScheduleItem[] = [];

    for (const slot of selectedSlots) {
      if (remaining <= 0) break;
      const slotMinutes = Math.min(slot.availableMinutes, remaining);
      if (slotMinutes > 0) {
        const start = slot.start;
        const end = addMinutes(start, slotMinutes);
        items.push({
          taskId: '',
          title: parsed.title || 'Untitled',
          start,
          end,
        });
        remaining -= slotMinutes;
      }
    }

    if (items.length === 0) {
      return this.telegramService.sendText(
        chatId,
        'Gue nggak nemu slot yang cukup panjang. Kurangin durasi atau perpanjang deadline?',
      );
    }

    const task = await this.tasksService.createTask(userId, parsed);

    let text = `📅 <b>Schedule Recommendation</b>\n\n`;
    text += `📌 <b>${escapeHtml(parsed.title || 'Untitled')}</b>\n`;
    text += `Duration: ${Math.round(duration / 60)}h${duration % 60}\n`;
    if (parsed.deadline) {
      text += `Deadline: ${format(new Date(parsed.deadline), 'EEE, dd MMM', { locale: idLocale })}\n`;
    }
    text += `\n`;

    items.forEach((item) => {
      text += `📝 ${escapeHtml(item.title)}\n`;
      text += `${format(item.start, 'EEE, dd MMM', { locale: idLocale })}\n`;
      text += `${format(item.start, 'HH:mm')} – ${format(item.end, 'HH:mm')}\n\n`;
    });

    const totalHours = Math.floor(duration / 60);
    const totalMins = duration % 60;
    text += `Total: ${totalHours}h${totalMins > 0 ? totalMins + 'm' : ''}\n`;

    const sched = await this.prisma.scheduledTask.create({
      data: {
        taskId: task.id,
        userId,
        startTime: items[0].start,
        endTime: items[items.length - 1].end,
        status: 'PENDING',
      },
    });

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `confirm:${sched.id}` },
          { text: '✏️ Modify', callback_data: `modify:${sched.id}` },
          { text: '❌ Cancel', callback_data: `cancel:${sched.id}` },
        ],
      ],
    };

    await this.telegramService.sendRecommendation(chatId, text, replyMarkup);

    return sched;
  }

  async confirmSchedule(chatId: number, userId: string, schedId: string) {
    const sched = await this.prisma.scheduledTask.findUnique({
      where: { id: schedId, userId },
      include: { task: true },
    });

    if (!sched) {
      await this.telegramService.sendText(chatId, '❌ Jadwal tidak ditemukan.');
      return;
    }

    const task = sched.task;
    this.logger.log(`Confirming schedule ${schedId}, taskId=${task.id}`);

    await this.prisma.scheduledTask.update({
      where: { id: schedId },
      data: { status: 'SCHEDULED' },
    });

    let calendarMsg = '📆 Jadwal tersimpan di lokal.';
    try {
      await this.calendar.createEvent(userId, {
        summary: task.title,
        description: task.description || '',
        start: sched.startTime,
        end: sched.endTime,
      });
      calendarMsg = '📆 Berhasil ditambahkan ke Google Calendar!';
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`Calendar create failed for sched ${schedId}: ${msg}`);
      const reason = msg.includes('not connected')
        ? 'hubungkan via /connect google'
        : msg;
      calendarMsg = `📆 Tersimpan di lokal (${reason})`;
    }

    await this.telegramService.sendText(
      chatId,
      `✅ Jadwal dikonfirmasi!\n\n` +
        `📌 ${escapeHtml(task.title)}\n` +
        `${format(sched.startTime, 'EEE, dd MMM', { locale: idLocale })}\n` +
        `${format(sched.startTime, 'HH:mm')} – ${format(sched.endTime, 'HH:mm')}\n\n` +
        escapeHtml(calendarMsg),
    );
  }

  async cancelSchedule(chatId: number, userId: string, schedId: string) {
    await this.prisma.scheduledTask.deleteMany({
      where: { id: schedId, userId },
    });

    await this.telegramService.sendText(chatId, '❌ Jadwal dibatalkan.');
  }

  async modifySchedule(chatId: number, userId: string, schedId: string) {
    const sched = await this.prisma.scheduledTask.findUnique({
      where: { id: schedId, userId },
      include: { task: true },
    });

    if (!sched || sched.status === 'CANCELLED') {
      await this.telegramService.sendText(chatId, '❌ Jadwal tidak ditemukan.');
      return;
    }

    await this.prisma.scheduledTask.deleteMany({
      where: { id: schedId, userId },
    });

    const parsed: ParsedTask = {
      intent: 'CREATE_TASK',
      title: sched.task.title,
      durationMinutes: sched.task.durationMinutes,
      priority: sched.task.priority as Priority,
      deadline: sched.task.deadline?.toISOString().split('T')[0],
    };

    const slots = await this.findAvailableSlots(userId, parsed);
    if (slots.length === 0) {
      await this.telegramService.sendText(
        chatId,
        'Maaf, gue nggak nemu slot kosong yang cocok. 😞',
      );
      return;
    }

    await this.sendRecommendation(chatId, userId, parsed, slots);
  }
}
