import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import axios from 'axios';
import { UsersService } from '../users/users.service';
import { AiService } from '../ai/ai.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { CalendarService } from '../calendar/calendar.service';
import {
  TelegramUpdate,
  TelegramWebhookResponse,
} from './telegram.interface';

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);

  protected botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  protected webhookUrl = process.env.TELEGRAM_WEBHOOK_URL ?? '';
  private schedulerService: SchedulerService;

  constructor(
    private readonly users: UsersService,
    private readonly ai: AiService,
    private readonly calendar: CalendarService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    // Lazy load SchedulerService to avoid circular dependency
    this.schedulerService = this.moduleRef.get(SchedulerService, { strict: false });

    if (this.botToken && this.webhookUrl) {
      try {
        await this.setWebhook();
        this.logger.log('Telegram webhook set successfully');
      } catch (err) {
        this.logger.warn(`Failed to set webhook: ${(err as Error).message}`);
      }
    } else {
      this.logger.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_URL not set');
    }
  }

  getBotUrl(): string {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  async setWebhook(): Promise<boolean> {
    if (!this.webhookUrl) return false;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    await axios.post(`${this.getBotUrl()}/setWebhook`, {
      url: this.webhookUrl,
      ...(secret ? { secret_token: secret } : {}),
    });
    return true;
  }

  async handleUpdate(update: TelegramUpdate): Promise<TelegramWebhookResponse> {
    try {
      if (update.callback_query) {
        await this.handleCallback(update.callback_query);
      }
      if (update.message) {
        await this.handleMessage(update.message);
      }
    } catch (err) {
      const message = err as Error;
      this.logger.error(`Error handling update: ${message.message}`);
    }
    return { ok: true };
  }

  private async handleMessage(message: any) {
    const { from, text } = message;

    // Find or create user
    let user = await this.users.findByTelegramId(String(from.id));
    if (!user) {
      user = await this.users.create(String(from.id), from.first_name);
    }

    if (text === '/start' || text === '/start@calendar_assistant_bot') {
      return this.sendText(message.chat.id, this.getStartMessage());
    }

    if (text === '/today') {
      const today = new Date();
      const start = new Date(today);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      const events = await this.calendar.getEvents(user.id, start, end);
      const msg = this.calendar.buildTodaySummary(events);
      return this.sendText(message.chat.id, msg);
    }

    if (text === '/connect google' || text === '/connect') {
      const baseUrl = process.env.BASE_URL || '';
      const authUrl = `${baseUrl}/auth/google?telegramId=${from.id}`;
      return this.sendText(
        message.chat.id,
        `🔗 Klik link berikut untuk mengkoneksikan Google Calendar:\n${authUrl}\n\nSetelah membuka link, pilih akun Google dan klik "Allow".`,
      );
    }

    if (text === '/week') {
      const today = new Date();
      const start = new Date(today);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - start.getDay());
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const events = await this.calendar.getEvents(user.id, start, end);
      const msg = this.calendar.buildWeekSummary(events);
      return this.sendText(message.chat.id, msg);
    }

    // Natural language task input
    if (text && text.trim()) {
      // Send typing indicator
      await this.sendAction(message.chat.id, 'typing');

      // Parse task via AI
      const parsed = await this.ai.parseTask(text);
      if (parsed.intent === 'CREATE_TASK') {
        // Get available slots
        const slots = await this.schedulerService.findAvailableSlots(user.id, parsed);
        if (slots.length === 0) {
          return this.sendText(
            message.chat.id,
            'Maaf, gue nggak nemu slot kosong yang cocok. 😞\nCoba kurangin durasi atau perpanjang deadline?',
          );
        }

        // Generate recommendation
        return this.schedulerService.sendRecommendation(message.chat.id, user.id, parsed, slots);
      }

      return this.sendText(message.chat.id, 'Ups, gue nggak ngerti maksudnya 😅');
    }
  }

  private async handleCallback(callback: any) {
    const { from, data, message } = callback;
    let user = await this.users.findByTelegramId(String(from.id));
    if (!user) {
      user = await this.users.create(String(from.id), from.first_name);
    }

    if (data.startsWith('confirm:')) {
      const schedId = data.split(':')[1];
      return this.schedulerService.confirmSchedule(message.chat.id, user.id, schedId);
    }

    if (data.startsWith('cancel:')) {
      const schedId = data.split(':')[1];
      return this.schedulerService.cancelSchedule(message.chat.id, user.id, schedId);
    }

    if (data.startsWith('modify:')) {
      const schedId = data.split(':')[1];
      return this.schedulerService.modifySchedule(message.chat.id, user.id, schedId);
    }
  }

  private getStartMessage(): string {
    return '🤖 Halo! Aku AI Calendar Assistant.\n\n' +
      'Kirim aja tugas yang mau kamu jadwalkan, misalnya:\n' +
      '"Besok gue harus belajar Python 2 jam."\n\n' +
      'Commands:\n' +
      '/today - Jadwal hari ini\n' +
      '/week - Ringkasan minggu ini\n' +
      '/connect google - Hubungkan Google Calendar';
  }

  async sendText(chatId: number, text: string) {
    await axios.post(`${this.getBotUrl()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  }

  async sendAction(chatId: number, action: string = 'typing') {
    await axios.post(`${this.getBotUrl()}/sendChatAction`, {
      chat_id: chatId,
      action,
    });
  }

  async sendRecommendation(
    chatId: number,
    text: string,
    inlineKeyboard: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    },
  ) {
    await axios.post(`${this.getBotUrl()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard,
    });
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    inlineKeyboard?: any,
  ) {
    await axios.post(`${this.getBotUrl()}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard,
    });
  }
}
