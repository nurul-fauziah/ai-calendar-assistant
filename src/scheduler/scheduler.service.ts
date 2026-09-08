import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CalendarService } from '../calendar/calendar.service';
import { PrismaService } from '../common/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { TasksService } from '../tasks/tasks.service';
import { ParsedTask, Priority } from '../ai/ai.interface';
import { escapeHtml } from '../common/html-escape';
import { localDateToUtc, toLocal } from '../common/timezone';
import { AvailableSlot, ScheduleItem } from './scheduler.interface';
import { addDays, addMinutes } from 'date-fns';
import { format } from 'date-fns-tz';
import { id as idLocale } from 'date-fns/locale/id';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private telegramService!: TelegramService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly tasksService: TasksService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    this.telegramService = this.moduleRef.get(TelegramService, { strict: false });
  }

  private async getTimezone(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    return user?.timezone || 'Asia/Jakarta';
  }

  async findAvailableSlots(
    userId: string,
    parsed: ParsedTask,
  ): Promise<AvailableSlot[]> {
    const { durationMinutes, deadline, preferredTime } = parsed;

    // Timezone user (default Asia/Jakarta) — semua hitung slot di zona ini.
    const tz = await this.getTimezone(userId);

    const now = new Date();
    // Deadline "YYYY-MM-DD" = hari TERAKHIR boleh kerja, jadi batas
    // pencarian = akhir hari itu (23:59 di zona user), bukan tengah
    // malamnya. Kalau boundary-nya 00:00, task dengan deadline hari ini
    // + sekarang udah siang → searchEnd lewat → slotnya 0.
    const searchEnd = deadline
      ? new Date(localDateToUtc(deadline, tz).getTime() + 24 * 60 * 60 * 1000)
      : addMinutes(now, 7 * 24 * 60);
    // Kalau user sebut hari spesifik ("besok", "senin"), start pencarian di
    // hari itu, bukan hari ini — biar "besok jam 1" nggak keburu recomm
    // slot hari ini dulu.
    const searchStart = parsed.date
      ? localDateToUtc(parsed.date, tz)
      : now;

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

    // Iterasi per hari di zona user. Loop `localDateStr` dari hari target
    // (atau hari ini kalau nggak spesifik) sampai searchEnd. Tiap hari
    // rekonstruksi batas 08:00–22:00 absolute lewat localDateToUtc, filter
    // busy yang overlap. Nggak pakai setHours/setDate (mutasi ikut zona
    // HOST), tapi addDays + format zona user biar boundary hari nggak geser.
    const dateKeys = [format(searchStart, 'yyyy-MM-dd', { timeZone: tz })];
    for (let g = 0; ; g++) {
      const lastKey = dateKeys[dateKeys.length - 1];
      const nextKey = format(
        addDays(localDateToUtc(lastKey, tz), 1),
        'yyyy-MM-dd',
        { timeZone: tz },
      );
      if (nextKey === lastKey || g > 92) break;
      dateKeys.push(nextKey);
    }
    const lastDayKey = format(searchEnd, 'yyyy-MM-dd', { timeZone: tz });

    for (const localDateStr of dateKeys) {
      if (localDateStr > lastDayKey) break;
      const dayStartAbs = localDateToUtc(localDateStr, tz);
      const dayEndAbs = addMinutes(dayStartAbs, 24 * 60);

      const dayEvents = busy
        .filter((e) => e.start < dayEndAbs && e.end > dayStartAbs)
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      // Work window: kalau user minta jam spesifik, mulai dari jam itu
      // (dibatasi minimal 08:00 biar nggak aneh), otherwise 08:00.
      const workStartHour = (parsed.preferredHour !== undefined && parsed.preferredHour >= 8 && parsed.preferredHour <= 22)
        ? parsed.preferredHour
        : 8;
      const workStartAbs = addMinutes(dayStartAbs, workStartHour * 60);
      const workEndAbs = addMinutes(dayStartAbs, 22 * 60);
      // Jangan kasih slot sebelum sekarang di hari ini
      let c = workStartAbs > now ? workStartAbs : now;
      for (const ev of dayEvents) {
        if (ev.start > c && ev.start <= workEndAbs) {
          const gapEnd = ev.start > workEndAbs ? workEndAbs : ev.start;
          const gap = (gapEnd.getTime() - c.getTime()) / 60000;
          if (gap >= (durationMinutes || 30)) {
            slots.push({ start: new Date(c), end: gapEnd, availableMinutes: gap });
          }
        }
        if (ev.end > c) c = ev.end > workEndAbs ? workEndAbs : ev.end;
      }
      if (c < workEndAbs) {
        const gap = (workEndAbs.getTime() - c.getTime()) / 60000;
        if (gap >= (durationMinutes || 30)) {
          slots.push({ start: new Date(c), end: workEndAbs, availableMinutes: gap });
        }
      }
    }

    if (preferredTime) {
      slots.sort((a, b) => this.scoreByPreference(a, b, preferredTime, tz));
    }

    // Buang slot yang sudah lewat / mulai sebelum sekarang
    return slots.filter((s) => s.start > now);
  }

  private scoreByPreference(a: AvailableSlot, b: AvailableSlot, pref: string, tz: string): number {
    const hour = (s: AvailableSlot) => toLocal(s.start, tz).getHours();
    const prefScores: Record<string, (h: number) => number> = {
      MORNING: (h) => (h >= 8 && h <= 12 ? 1 : 0),
      AFTERNOON: (h) => (h > 12 && h <= 15 ? 1 : 0),
      EVENING: (h) => (h > 15 && h <= 19 ? 1 : 0),
      NIGHT: (h) => (h > 19 && h <= 22 ? 1 : 0),
    };
    const scorer = prefScores[pref] || (() => 0);
    return scorer(hour(b)) - scorer(hour(a));
  }

  async sendRecommendation(
    chatId: number,
    userId: string,
    parsed: ParsedTask,
    slots: AvailableSlot[],
    existingTaskId?: string,
  ) {
    const tz = await this.getTimezone(userId);
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

    // Reuse task yang sudah ada (saat modify) daripada bikin task duplikat.
    const task = existingTaskId
      ? await this.prisma.task.findUnique({ where: { id: existingTaskId } })
      : await this.tasksService.createTask(userId, parsed);
    if (!task) {
      await this.telegramService.sendText(chatId, '❌ Task tidak ditemukan.');
      return;
    }

    let text = `📅 <b>Schedule Recommendation</b>\n\n`;
    text += `📌 <b>${escapeHtml(parsed.title || 'Untitled')}</b>\n`;
    text += `Duration: ${Math.round(duration / 60)}h${duration % 60}\n`;
    if (parsed.deadline) {
      text += `Deadline: ${format(localDateToUtc(parsed.deadline, tz), 'EEE, dd MMM', { locale: idLocale })}\n`;
    }
    text += `\n`;

    items.forEach((item) => {
      text += `📝 ${escapeHtml(item.title)}\n`;
      text += `${format(toLocal(item.start, tz), 'EEE, dd MMM', { locale: idLocale })}\n`;
      text += `${format(toLocal(item.start, tz), 'HH:mm')} – ${format(toLocal(item.end, tz), 'HH:mm')}\n\n`;
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

    const tz = await this.getTimezone(userId);
    const task = sched.task;
    this.logger.log(`Confirming schedule ${schedId}, taskId=${task.id}`);

    // Guard double-book: jangan kunci slot yang sudah ditempati task lain
    // (PENDING/SCHEDULED). Kasus race pas dua rekomendasi jalan bersamaan.
    const clash = await this.prisma.scheduledTask.findFirst({
      where: {
        userId,
        id: { not: schedId },
        status: { not: 'CANCELLED' },
        startTime: { lt: sched.endTime },
        endTime: { gt: sched.startTime },
      },
    });
    if (clash) {
      await this.telegramService.sendText(
        chatId,
        '⚠️ Slot ini bentrok sama jadwal lain. Ketik ulang permintaan kamu buat nyari slot baru.',
      );
      return;
    }

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
        `${format(toLocal(sched.startTime, tz), 'EEE, dd MMM', { locale: idLocale })}\n` +
        `${format(toLocal(sched.startTime, tz), 'HH:mm')} – ${format(toLocal(sched.endTime, tz), 'HH:mm')}\n\n` +
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

    // Hapus slot lama yang pending; task-nya KEEP (jangan duplikat).
    await this.prisma.scheduledTask.deleteMany({
      where: { id: schedId, userId },
    });

    const tz = await this.getTimezone(userId);
    const deadlineStr = sched.task.deadline
      ? format(toLocal(sched.task.deadline, tz), 'yyyy-MM-dd')
      : undefined;
    const parsed: ParsedTask = {
      intent: 'CREATE_TASK',
      title: sched.task.title,
      durationMinutes: sched.task.durationMinutes,
      priority: sched.task.priority as Priority,
      deadline: deadlineStr,
      // Cari di hari deadline asli, bukan mulai hari ini (biar "besok"
      // si user nggak dapat rekomendasi hari ini).
      date: deadlineStr,
    };

    const slots = await this.findAvailableSlots(userId, parsed);
    if (slots.length === 0) {
      await this.telegramService.sendText(
        chatId,
        'Maaf, gue nggak nemu slot kosong yang cocok. 😞',
      );
      return;
    }

    await this.sendRecommendation(chatId, userId, parsed, slots, sched.taskId);
  }
}
