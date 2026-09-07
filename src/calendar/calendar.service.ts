import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { encryptToken, decryptToken } from '../common/crypto.util';
import { escapeHtml } from '../common/html-escape';

export interface CalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  recurrence?: string[];
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly encKey?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
    this.encKey = config.get<string>('TOKEN_ENCRYPTION_KEY');
  }

  async getEvents(userId: string, start: Date, end: Date): Promise<CalendarEvent[]> {
    try {
      const token = await this.getValidToken(userId);
      if (!token) return [];

      const res = await axios.get(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
          },
        },
      );

      return res.data.items.map((e: any) => ({
        id: e.id,
        summary: e.summary,
        description: e.description,
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date),
        recurrence: e.recurrence,
      }));
    } catch (err) {
      const e = err as Error;
      this.logger.error(`Failed to fetch events: ${e.message}`);
      return [];
    }
  }

  async createEvent(userId: string, event: CalendarEvent) {
    try {
      const token = await this.getValidToken(userId);
      if (!token) throw new Error('Google Calendar not connected');

      const res = await axios.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          summary: event.summary,
          description: event.description,
          start: {
            dateTime: event.start.toISOString(),
            timeZone: 'Asia/Jakarta',
          },
          end: {
            dateTime: event.end.toISOString(),
            timeZone: 'Asia/Jakarta',
          },
          recurrence: event.recurrence,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      return res.data;
    } catch (err) {
      const e = err as Error;
      this.logger.error(`Failed to create event: ${e.message}`);
      throw e;
    }
  }

  buildTodaySummary(events: CalendarEvent[]): string {
    let msg = '📅 <b>Today</b>\n\n';
    if (events.length === 0) {
      msg += '📭 Nggak ada jadwal hari ini.';
    } else {
      for (const e of events) {
        const ts = e.start.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const te = e.end.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        msg += `${ts} – ${te}\n${escapeHtml(e.summary)}\n\n`;
      }
    }
    return msg;
  }

  buildWeekSummary(events: CalendarEvent[]): string {
    let msg = '📅 <b>This Week</b>\n\n';
    if (events.length === 0) {
      msg += '📭 Nggak ada jadwal minggu ini.';
    } else {
      for (const e of events) {
        const day = e.start.toLocaleDateString('id-ID', { weekday: 'long' });
        const time = e.start.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        msg += `${day}\n${time} ${escapeHtml(e.summary)}\n\n`;
      }
    }
    return msg;
  }

  async getValidToken(userId: string): Promise<string | null> {
    const conn = await this.prisma.googleConnection.findUnique({
      where: { userId },
    });

    if (!conn) return null;

    let accessToken: string;
    try {
      accessToken = decryptToken(conn.accessToken, this.encKey);
    } catch (err) {
      this.logger.error(`Token decrypt failed for ${userId}`);
      return null;
    }

    if (Date.now() < conn.expiresAt.getTime()) {
      return accessToken;
    }

    try {
      let refreshToken: string;
      try {
        refreshToken = decryptToken(conn.refreshToken, this.encKey);
      } catch (err) {
        this.logger.error('Refresh token decrypt failed');
        return null;
      }

      const res = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });

      const { access_token, expires_in = 3600 } = res.data;
      const newExpiry = new Date(Date.now() + expires_in * 1000);

      await this.prisma.googleConnection.update({
        where: { userId },
        data: {
          accessToken: encryptToken(access_token, this.encKey),
          expiresAt: newExpiry,
        },
      });

      return access_token;
    } catch (err) {
      this.logger.error('Failed to refresh Google token');
      return null;
    }
  }
}
