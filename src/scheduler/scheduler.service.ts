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
import { addDays, addMinutes, addMonths } from 'date-fns';
import { format } from 'date-fns-tz';
import { id as idLocale } from 'date-fns/locale/id';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private telegramService!: TelegramService;

  // Default durasi kalau user nggak sebut. Eksplisit & terdokumentasi
  // (bukan "invent 1 jam"): dipakai konsisten buat slot & pesan.
  private static readonly DEFAULT_DURATION_MINUTES = 60;

  // Thread rekomendasi terakhir per user (pesan + sched id) — dipakai buat
  // Modify klik ngedit pesan yang SAMA, bukan bikin pesan baru.
  private latestRecommendation = new Map<
    string,
    { schedId: string; taskId: string; chatId: number; messageId?: number }
  >();

  // User yang lagi AWAITING teks perubahan (habis klik Modify). Satu alur
  // aktif per user. Dipakai juga sebagai gate: teks beikutnya = perubahan,
  // bukan task baru. Hanya di-set oleh modifySchedule, di-clear oleh
  // continueModify/cancel/reset — BUKAN setelah recomendation dikirim.
  private pendingModify = new Map<
    string,
    { schedId: string; taskId: string; chatId: number; messageId?: number }
  >();

  // Negara bagian untuk klarifikasi recurrence: user udah bilang "setiap
  // senin" tapi belum kasih jam mulai. Di-set saat recommendation 'needsTime',
  // di-clear saat jawaban diterima / batal / reset.
  private pendingRecurTime = new Map<
    string,
    { chatId: number; taskId: string; rrule: string; title: string }
  >();

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
    // Recurring task: search start = occurrence PERTAMA (next Rabu dst),
    // BUKAN "sekarang / slot kosong pertama" — biar preview jatuh di hari
    // pola yang bener ("setiap rabu" = Rabu, bukan Kamis).
    const searchStart = parsed.recurrenceRule
      ? this.firstOccurrenceForRule(parsed.recurrenceRule, tz)
      : parsed.date
        ? localDateToUtc(parsed.date, tz)
        : now;

    const [events, dbEvents] = await Promise.all([
      this.calendar.getEvents(userId, now, searchEnd),
      this.prisma.scheduledTask.findMany({
        where: {
          userId,
          // Hanya slot KONFIRMASI (SCHEDULED) yang dianggap busy. Rekomendasi
          // yang masih PENDING itu cuma saran — nggak nge-block slot. Sebelum
          // ini PENDING ikut dihitung → rekomendasi-rekomendasi lama yang
          // nggak pernah dikonfirmasi bikin slot jadi "bentrok" dan saran
          // loncat ke 16:50/19:00 tanpa sebab.
          status: 'SCHEDULED',
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
    editMessageId?: number,
  ) {
    const tz = await this.getTimezone(userId);
    const now = new Date();
    const duration = parsed.durationMinutes ?? SchedulerService.DEFAULT_DURATION_MINUTES;

    // Recurring task: user udah bilang polanya tapi belum sebut jam → minta
    // jam mulai dulu (klarifikasi), bukan langsung ngarang slot.
    if (parsed.recurrenceRule && !/BYHOUR=/.test(parsed.recurrenceRule)) {
      this.pendingRecurTime.set(userId, {
        chatId,
        taskId: existingTaskId ?? '',
        rrule: parsed.recurrenceRule,
        title: parsed.title || 'Untitled',
      });
      await this.telegramService.sendText(
        chatId,
        '🔁 Udahan untuk jadwal ulang, tapi jamnya belum disebut. Ketik jam mulainya, misal <code>jam 7 pagi</code> atau <code>15.30</code>.',
      );
      return;
    }
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
    if (parsed.recurrenceRule) {
      text += `🔁 ${this.describeRecurrence(parsed.recurrenceRule)}\n`;
    }
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

    // Unique (userId, taskId, status) → kalau rekomendasi yang sama diproses
    // 2x (race / retry webhook), create kedua kena P2002. Reuse sched lama
    // daripada crash / bikin duplikat.
    let sched;
    try {
      sched = await this.prisma.scheduledTask.create({
        data: {
          taskId: task.id,
          userId,
          startTime: items[0].start,
          endTime: items[items.length - 1].end,
          status: 'PENDING',
          recurrence: parsed.recurrenceRule,
        },
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2002') {
        sched = await this.prisma.scheduledTask.findFirst({
          where: { userId, taskId: task.id, status: 'PENDING' },
        });
        if (!sched) throw err;
      } else {
        throw err;
      }
    }

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `confirm:${sched.id}` },
          { text: '✏️ Modify', callback_data: `modify:${sched.id}` },
          { text: '❌ Cancel', callback_data: `cancel:${sched.id}` },
        ],
      ],
    };

    // Kirim rekomendasi. editMessageId di-set (saat modify) → EDIT pesan lama,
    // satu thread. Tanpa itu → pesan baru. Terus ingat thread-nya buat alur
    // modify berikutnya.
    return this.postRecommendation(
      chatId,
      userId,
      sched.id,
      task.id,
      text,
      replyMarkup,
      editMessageId,
    );
  }

  // Kirim/edit rekomendasi, ingat thread-nya. editMessageId → edit pesan
  // yang sudah ada; undefined → kirim pesan baru.
  private async postRecommendation(
    chatId: number,
    userId: string,
    schedId: string,
    taskId: string,
    text: string,
    replyMarkup: any,
    editMessageId?: number,
  ) {
    let messageId: number | undefined;
    if (editMessageId) {
      await this.telegramService.editMessage(chatId, editMessageId, text, replyMarkup);
      messageId = editMessageId;
    } else {
      const res = await this.telegramService.sendRecommendation(chatId, text, replyMarkup);
      messageId = res?.messageId;
    }
    this.latestRecommendation.set(userId, { schedId, taskId, chatId, messageId });
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
        rrule: sched.recurrence ?? undefined,
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
        (sched.recurrence ? `🔁 ${this.describeRecurrence(sched.recurrence)}\n` : '') +
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

  hasPendingRecurTime(userId: string): boolean {
    return this.pendingRecurTime.has(userId);
  }

  // /start (atau perintah lain yang minta reset): bersihin semua state
  // sesi — pending modify, thread rekomendasi lama, plus rekomendasi
  // PENDING di DB yang nggak pernah dikonfirmasi. Bukan motong task /
  // schedule yang udah KONFIRMASI (SCHEDULED).
  async resetConversation(userId: string): Promise<void> {
    this.pendingModify.delete(userId);
    this.pendingRecurTime.delete(userId);
    this.latestRecommendation.delete(userId);
    await this.prisma.scheduledTask.deleteMany({
      where: { userId, status: 'PENDING' },
    });
  }

  // Mulai alur modify: kunci state user, tanya apa yang mau diubah.
  // Slot lama TIDAK dihapus dulu — dihapus pas user kasih perubahan, biar
  // kalau dia batal, jadwal asli tetap ada. Re-click Modify ketika sudah
  // pending → ignore (nggak nimpa state / nggak nanya 2x).
  async modifySchedule(chatId: number, userId: string, schedId: string) {
    if (this.pendingModify.has(userId)) {
      return; // udah lagi proses modify buat task ini — nggak usah dobel
    }

    const sched = await this.prisma.scheduledTask.findUnique({
      where: { id: schedId, userId },
      include: { task: true },
    });

    if (!sched || sched.status === 'CANCELLED') {
      await this.telegramService.sendText(chatId, '❌ Jadwal tidak ditemukan.');
      return;
    }

    // Ambil thread pesan rekomendasi dari latestRecommendation biar prompt
    // ngedit pesan yg sama (kalau ada), bukan nyetak prompt baru. Cuma
    // dipakai kalau rec itu untuk sched yang sama (biar nggak ngedit pesan
    // rekomendasi lain kalau state kebawa).
    const rec = this.latestRecommendation.get(userId);
    const editMessageId =
      rec && rec.schedId === schedId ? rec.messageId : undefined;

    this.pendingModify.set(userId, {
      schedId,
      taskId: sched.taskId,
      chatId,
      messageId: editMessageId,
    });

    const tz = await this.getTimezone(userId);
    const promptText =
      `✏️ Mau diubah apa dari jadwal ini?\n\n` +
      `📌 <b>${escapeHtml(sched.task.title)}</b>\n` +
      `${format(toLocal(sched.startTime, tz), 'EEE, dd MMM', { locale: idLocale })} ` +
      `${format(toLocal(sched.startTime, tz), 'HH:mm')} – ${format(toLocal(sched.endTime, tz), 'HH:mm')}\n\n` +
      `Ketik perubahan, misalnya:\n` +
      `• <code>pindah jam 15.50</code>\n` +
      `• <code>jadinya besok jam 10</code>\n` +
      `• <code>durasi 2 jam</code>\n` +
      `• <code>ganti judul belajar java</code>\n\n` +
      `Atau ketik <code>batal</code> buat nggak jadi.`;

    if (editMessageId) {
      await this.telegramService.editMessage(chatId, editMessageId, promptText);
    } else {
      await this.telegramService.sendText(chatId, promptText);
    }
  }

  // Langkah 2: user udah ketik perubahan. Terapkan semua field baru dari
  // parse, update task, hapus slot lama, cari slot baru — TANPA bikin task
  // duplikat & TANPA nanya "Mau diubah apa?" lagi.
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
    if (asked.intent === 'UNKNOWN') {
      await this.telegramService.sendText(
        chatId,
        'Hmm, gue nggak ngerti maksudnya. Ketik ulang perubahan, contoh: <code>pindah jam 15.50</code>',
      );
      return; // tetep pending, user bisa coba lagi
    }

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

    // Render rekomendasi baru (title dari parsed; tz sama seperti asli) dan
    // EDIT pesan yang sama (satu thread) — nggak nyetak pesan baru.
    this.pendingModify.delete(userId);
    await this.sendRecommendation(
      chatId,
      userId,
      parsed,
      slots,
      sched.taskId,
      pending.messageId,
    );
  }

  // User lagi ngerjain recurrence tanpa jam (klarifikasi). Jawaban berikutnya
  // = jam mulai. Terapkan ke task, hitung occurrence pertama, rekomendasiin.
  async continueRecurTime(chatId: number, userId: string, text: string) {
    const pending = this.pendingRecurTime.get(userId);
    if (!pending) return;

    if (/^(batal|cancel|nggak jadi)\b/i.test(text.trim())) {
      this.pendingRecurTime.delete(userId);
      await this.telegramService.sendText(chatId, 'Oke, jadwal ulang dibatalkan.');
      return;
    }

    const tz = await this.getTimezone(userId);

    // Parse jam dari text user. Pakai mode "recurring" (strict) biar
    // "jam 7" = 07:00, bukan 19:00.
    const preferredMinutes = this.parseTimeForRecurring(text);
    if (preferredMinutes === undefined) {
      await this.telegramService.sendText(
        chatId,
        'Jam mulainya yang mana? Contoh: <code>jam 7 pagi</code> atau <code>15.30</code>.',
      );
      return; // tetep pending
    }

    const rule = pending.rrule.replace(
      /(;BYHOUR=\d+;BYMINUTE=\d+)?$/,
      `;BYHOUR=${Math.floor(preferredMinutes / 60)};BYMINUTE=${preferredMinutes % 60}`,
    );
    let task = pending.taskId
      ? await this.prisma.task.findUnique({ where: { id: pending.taskId } })
      : null;

    const parsed: ParsedTask = {
      intent: 'CREATE_TASK',
      title: pending.title,
      durationMinutes: task?.durationMinutes ?? SchedulerService.DEFAULT_DURATION_MINUTES,
      preferredMinutes,
      recurrenceRule: rule,
    };
    const parsedFull = { ...parsed, title: pending.title };

    // Kalau task belum ada (baru ambiguous recurring diawal), bikin sekarang.
    if (!task) {
      task = await this.tasksService.createTask(userId, parsedFull);
      this.pendingRecurTime.set(userId, { ...pending, taskId: task.id });
    } else {
      await this.prisma.task.update({
        where: { id: task.id },
        data: { recurrence: rule },
      });
    }

    this.pendingRecurTime.delete(userId);

    const start = this.firstOccurrenceForRule(rule, tz);
    const end = addMinutes(start, parsed.durationMinutes || SchedulerService.DEFAULT_DURATION_MINUTES);
    const slot: AvailableSlot = { start, end, availableMinutes: parsed.durationMinutes || SchedulerService.DEFAULT_DURATION_MINUTES };

    // Cek konflik occurrence pertama sama Google Calendar.
    const conflict = await this.calendar.checkRecurConflict(userId, start, end, tz);
    if (conflict) {
      await this.telegramService.sendText(
        chatId,
        `⚠️ Jam itu bentrok sama jadwal lain. Coba jam lain? Ketik jam barunya.`,
      );
      this.pendingRecurTime.set(userId, { ...pending, taskId: task.id, rrule: rule });
      return;
    }

    await this.sendRecommendation(chatId, userId, parsedFull, [slot], task.id);
  }

  // Parse waktu untuk konteks recurring (strict): "jam 7" = 07:00, "jam 7 pagi" = 07:00,
  // "jam 7 malam" = 19:00, "15.30" = 15:30, "jam 3 sore" = 15:00.
  private parseTimeForRecurring(text: string): number | undefined {
    const lower = text.toLowerCase().trim();

    // Helper: resolve jam/menit + periode ke menit absolut (0-1439).
    // strict = true → nggak geser 1-7 ke PM.
    const resolveTime = (hRaw: number, mRaw: number | undefined, period?: string): number | undefined => {
      if (hRaw > 24 || (mRaw !== undefined && mRaw >= 60)) return undefined;
      let h = hRaw;
      if (mRaw !== undefined) {
        // Menit eksplisit = jam sudah pasti.
      } else if (period === 'siang' || period === 'sore' || period === 'malam') {
        // Tanpa menit + periode: "jam 1 siang"=13, "jam 3 sore"=15, "jam 8 malam"=20.
        if (h <= 11) h += 12;
      }
      // strict mode: nggak geser 1-7 ke PM.
      return h * 60 + (mRaw || 0);
    };

    // Bentuk 1: "jam 7", "jam 7 pagi", "pukul 15", "jam 15.30", "jam 3 sore"
    const prefixMatch = /\b(?:jam|pukul)\s+(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?\s*(pagi|siang|sore|malam)?/i.exec(text);
    if (prefixMatch) {
      return resolveTime(
        parseInt(prefixMatch[1], 10),
        prefixMatch[2] !== undefined ? parseInt(prefixMatch[2], 10) : undefined,
        prefixMatch[3],
      );
    }

    // Bentuk 2: "15.30", "07:00" (bare time)
    const bareMatch = /(?<![\d:.])(\d{1,2})\s*[:.]\s*(\d{1,2})(?!\s*(?:jam|pukul))/i.exec(text);
    if (bareMatch) {
      return resolveTime(
        parseInt(bareMatch[1], 10),
        parseInt(bareMatch[2], 10),
      );
    }

    return undefined;
  }

  // Human-readable label dari RRULE buat pesan rekomendasi.
  private describeRecurrence(rule: string): string {
    const byDay = /BYDAY=([A-Z]+)/.exec(rule)?.[1];
    const byMonthDay = /BYMONTHDAY=(\d+)/.exec(rule)?.[1];
    const hour = /BYHOUR=(\d+)/.exec(rule)?.[1];
    const minute = /BYMINUTE=(\d+)/.exec(rule)?.[1];
    const time = hour !== undefined
      ? `${String(+hour).padStart(2, '0')}:${String(+(minute || 0)).padStart(2, '0')}`
      : '';

    let freq: string;
    if (rule.startsWith('FREQ=DAILY')) freq = 'Every day';
    else if (rule.startsWith('FREQ=WEEKLY')) freq = 'Every week';
    else if (rule.startsWith('FREQ=MONTHLY')) freq = 'Every month';
    else freq = rule;

    if (byDay) {
      const names: Record<string, string> = {
        MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
        FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
      };
      freq += ` on ${names[byDay] || byDay}`;
    }
    if (byMonthDay) freq += ` on day ${byMonthDay}`;
    if (time) freq += ` at ${time}`;
    return freq;
  }

  // Occurrence pertama dari RRULE, dihitung dari hari ini (zona user).
  private firstOccurrenceForRule(rule: string, tz = 'Asia/Jakarta'): Date {
    const today = new Date();
    const weekday = /BYDAY=(MO|TU|WE|TH|FR|SA|SU)/.exec(rule)?.[1];
    const monthDay = /BYMONTHDAY=(\d+)/.exec(rule)?.[1];
    const hourRaw = /BYHOUR=(\d+)/.exec(rule)?.[1];
    const minuteRaw = /BYMINUTE=(\d+)/.exec(rule)?.[1];
    const hour = hourRaw !== undefined ? +hourRaw : undefined;
    const minute = minuteRaw !== undefined ? +minuteRaw : 0;

    // Mulai-hari (midnight zona user) tanggal itu + jam mulai kalau ada.
    // localDateToUtc SUDAH nambah "T00:00:00" — jangan dobel.
    const at = (d: Date) => {
      const local = format(d, 'yyyy-MM-dd', { timeZone: tz });
      const abs = localDateToUtc(local, tz);
      return hour !== undefined ? addMinutes(abs, hour * 60 + minute) : abs;
    };

    let first: Date;
    if (rule.startsWith('FREQ=DAILY')) {
      first = at(today);
    } else if (weekday) {
      const iso: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
      const target = iso[weekday];
      const todayIso = toLocal(today, tz).getDay();
      let diff = (target - todayIso + 7) % 7;
      if (diff === 0) diff = 7; // hari ini udah lewat → minggu depan
      first = at(addDays(today, diff));
    } else if (monthDay) {
      // Hari (local) di bulan ini, clip 29-31 Feb/Apr dst. String tanggal biar
      // format lokal user konsisten, bukan mutasi host-local.
      const mday = +monthDay;
      const monthDayOf = (d: Date) => {
        const y = +format(d, 'yyyy', { timeZone: tz });
        const m = +format(d, 'MM', { timeZone: tz });
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(mday, last)).padStart(2, '0')}`;
      };
      let cand = monthDayOf(today);
      if (cand < format(today, 'yyyy-MM-dd', { timeZone: tz })) {
        cand = monthDayOf(addMonths(today, 1));
      }
      first = localDateToUtc(cand, tz);
      if (hour !== undefined) first = addMinutes(first, hour * 60 + minute);
    } else {
      first = at(today);
    }
    return first;
  }

}
