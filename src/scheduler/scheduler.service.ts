import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CalendarService } from '../calendar/calendar.service';
import { PrismaService } from '../common/prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { TasksService } from '../tasks/tasks.service';
import { ParsedTask, Priority } from '../ai/ai.interface';
import { AiService } from '../ai/ai.service';
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

  // Default durasi kalau user nggak sebut. Eksplisit & terdokumentasi
  // (bukan "invent 1 jam"): dipakai konsisten buat slot & pesan.
  private static readonly DEFAULT_DURATION_MINUTES = 60;

  // State modify pending per user (in-memory; bot single-instance).
  // Map<userId, { schedId, taskId }>. User yang lagi proses modify nggak
  // boleh nimpa/numpuk — cukup satu alur aktif.
  private pendingModify = new Map<string, { schedId: string; taskId: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly tasksService: TasksService,
    private readonly aiService: AiService,
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

      // Work window: kalau user minta jam spesifik (preferredMinutes presisi),
      // mulai dari jam itu, otherwise 08:00. Nggak di-clamp ke 8:00 —
      // "11.50" harus mulai 11:50, bukan jam 8.
      const workStartAbs = parsed.preferredMinutes !== undefined
        ? addMinutes(dayStartAbs, parsed.preferredMinutes)
        : addMinutes(dayStartAbs, 8 * 60);
      const workEndAbs = addMinutes(dayStartAbs, 22 * 60);
      // Jangan kasih slot sebelum sekarang di hari ini. Kalau user minta
      // jam spesifik ("14:50") dan itu masih di depan → mulai TEPAT di
      // 14:50. Kalau udah lewat / bentrok, c = geser ke now/after-busy
      // dan sendRecommendation ngasih tau.
      const dur = durationMinutes ?? SchedulerService.DEFAULT_DURATION_MINUTES;
      let c = workStartAbs > now ? workStartAbs : now;
      for (const ev of dayEvents) {
        if (ev.start > c && ev.start <= workEndAbs) {
          const gapEnd = ev.start > workEndAbs ? workEndAbs : ev.start;
          const gap = (gapEnd.getTime() - c.getTime()) / 60000;
          if (gap >= dur) {
            slots.push({ start: new Date(c), end: gapEnd, availableMinutes: gap });
          }
        }
        if (ev.end > c) c = ev.end > workEndAbs ? workEndAbs : ev.end;
      }
      if (c < workEndAbs) {
        const gap = (workEndAbs.getTime() - c.getTime()) / 60000;
        if (gap >= dur) {
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
    const now = new Date();
    const duration = parsed.durationMinutes ?? SchedulerService.DEFAULT_DURATION_MINUTES;
    const selectedSlots = slots.slice(0, 3).filter((s) => s.availableMinutes >= duration);

    if (selectedSlots.length === 0) {
      return this.telegramService.sendText(
        chatId,
        'Gue nggak nemu slot yang cukup panjang. Kurangin durasi atau perpanjang deadline?',
      );
    }

    // Kalau user minta jam spesifik tapi slot pertama nggak mulai di jam
    // itu, berarti diminta udah lewat / bentrok → kasih tau + saran.
    let startNotice = '';
    if (parsed.preferredMinutes !== undefined && selectedSlots[0]) {
      const asked = parsed.preferredMinutes;
      const got = toLocal(selectedSlots[0].start, tz).getHours() * 60 +
        toLocal(selectedSlots[0].start, tz).getMinutes();
      if (got !== asked) {
        const askedStr = `${String(Math.floor(asked / 60)).padStart(2, '0')}:${String(asked % 60).padStart(2, '0')}`;
        startNotice =
          `⚠️ <b>Jam ${askedStr} nggak bisa</b> (${selectedSlots[0].start <= now ? 'udah lewat' : 'bentrok sama jadwal lain'}). ` +
          `Slot terdekat:\n`;
      }
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
    if (startNotice) text += startNotice + '\n';
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

  hasPendingModify(userId: string): boolean {
    return this.pendingModify.has(userId);
  }

  // Mulai alur modify: kunci state user, tanya apa yang mau diubah.
  // Slot lama TIDAK dihapus dulu — dihapus pas user kasih perubahan, biar
  // kalau dia batal, jadwal asli tetap ada.
  async modifySchedule(chatId: number, userId: string, schedId: string) {
    const sched = await this.prisma.scheduledTask.findUnique({
      where: { id: schedId, userId },
      include: { task: true },
    });

    if (!sched || sched.status === 'CANCELLED') {
      await this.telegramService.sendText(chatId, '❌ Jadwal tidak ditemukan.');
      return;
    }

    this.pendingModify.set(userId, { schedId, taskId: sched.taskId });

    const tz = await this.getTimezone(userId);
    await this.telegramService.sendText(
      chatId,
      `✏️ Mau diubah apa dari jadwal ini?\n\n` +
        `📌 <b>${escapeHtml(sched.task.title)}</b>\n` +
        `${format(toLocal(sched.startTime, tz), 'EEE, dd MMM', { locale: idLocale })} ` +
        `${format(toLocal(sched.startTime, tz), 'HH:mm')} – ${format(toLocal(sched.endTime, tz), 'HH:mm')}\n\n` +
        `Ketik perubahan, misalnya:\n` +
        `• <code>pindah jam 3 sore</code>\n` +
        `• <code>jadinya besok jam 10</code>\n` +
        `• <code>durasi 2 jam</code>\n` +
        `• <code>ganti judul belajar java</code>\n\n` +
        `Atau ketik <code>batal</code> buat nggak jadi.`,
    );
  }

  // Langkah 2: user udah ketik perubahan. Terapkan semua field baru dari
  // parse, update task, hapus slot lama, lalu re-recommend.
  async continueModify(chatId: number, userId: string, text: string) {
    const pending = this.pendingModify.get(userId);
    if (!pending) {
      await this.telegramService.sendText(
        chatId,
        'Nggak ada jadwal yang lagi dimodify. Ketik aja task baru kalau mau jadwalin.',
      );
      return;
    }

    if (/^(batal|cancel|nggak jadi)\b/i.test(text.trim())) {
      this.pendingModify.delete(userId);
      await this.telegramService.sendText(chatId, 'Oke, modify dibatalkan.');
      return;
    }

    const sched = await this.prisma.scheduledTask.findUnique({
      where: { id: pending.schedId, userId },
      include: { task: true },
    });
    if (!sched || sched.status === 'CANCELLED') {
      this.pendingModify.delete(userId);
      await this.telegramService.sendText(chatId, '❌ Jadwal tidak ditemukan.');
      return;
    }

    const tz = await this.getTimezone(userId);
    // Parse perubahan; field yang nggak disebut tetap dari task asli.
    const asked = await this.aiService.parseTask(text, tz);

    // Judul cuma diganti kalau user EKSPLISIT minta ("ganti judul ...",
    // "ubah judul ..."). "pindah jam 3 sore" → parser kasih title "pindah"
    // gara-gara waktu/strip — itu BUKAN perubahan judul.
    let title = sched.task.title;
    const wantsTitleChange = /(ganti|ubah|rename)\s+judul\s+(?:jadi\s+)?(.+)/i.test(text);
    if (wantsTitleChange) {
      const m = /(?:ganti|ubah|rename)\s+judul\s+(?:jadi\s+)?(.+)/i.exec(text);
      title = m![1].trim();
    }

    let duration = sched.task.durationMinutes;
    if (asked.durationMinutes) {
      duration = asked.durationMinutes;
    }

    // Deadline: "besok"/"senin" → requested date. Disebut "hari ini" juga
    // ke-set. Kalau nggak ada, keep asli.
    let deadline = sched.task.deadline;
    if (asked.deadline) {
      deadline = new Date(asked.deadline);
    }

    const parsed: ParsedTask = {
      intent: 'CREATE_TASK',
      title,
      durationMinutes: duration,
      priority: (sched.task.priority || 'NORMAL') as Priority,
      deadline: deadline ? format(toLocal(deadline, tz), 'yyyy-MM-dd') : undefined,
      // Cari di tanggal target (kalau user sebut), else di hari deadline/
      // hari ini — bukan mulai sekarang.
      date: asked.date || (deadline ? format(toLocal(deadline, tz), 'yyyy-MM-dd') : undefined),
      preferredMinutes: asked.preferredMinutes,
    };

    // Update task-nya (judul/durasi/deadline yang berubah).
    await this.prisma.task.update({
      where: { id: sched.taskId },
      data: {
        title,
        durationMinutes: duration,
        ...(deadline ? { deadline } : {}),
      },
    });

    // Hapus slot lama, cari pengganti.
    await this.prisma.scheduledTask.deleteMany({
      where: { id: sched.id, userId },
    });

    const slots = await this.findAvailableSlots(userId, parsed);
    if (slots.length === 0) {
      this.pendingModify.delete(userId);
      await this.telegramService.sendText(
        chatId,
        'Maaf, gue nggak nemu slot kosong yang cocok. 😞',
      );
      return;
    }

    this.pendingModify.delete(userId);
    await this.sendRecommendation(chatId, userId, parsed, slots, sched.taskId);
  }
}
