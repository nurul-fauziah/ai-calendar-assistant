import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { format } from 'date-fns-tz';
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

      // Kirim sebagai wall-clock local user (tanpa Z), bukan UTC ISO. Kalau
      // kirim toISOString() + timeZone, Google baca ulang string itu sebagai
      // UTC → "jam 13 WIB" jadi "jam 13 UTC" = jadwal geser 7 jam.
      const tz = await this.getTimezone(userId);
      const localStart = format(event.start, "yyyy-MM-dd'T'HH:mm:ss", { timeZone: tz });
      const localEnd = format(event.end, "yyyy-MM-dd'T'HH:mm:ss", { timeZone: tz });

      const res = await axios.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          summary: event.summary,
          description: event.description,
          start: {
            dateTime: localStart,
            timeZone: tz,
          },
          end: {
            dateTime: localEnd,
            timeZone: tz,
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

  private async getTimezone(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    return user?.timezone || 'Asia/Jakarta';
  }

  buildTodaySummary(events: CalendarEvent[], tz = 'Asia/Jakarta'): string {
    let msg = '📅 <b>Today</b>\n\n';
    if (events.length === 0) {
      msg += '📭 Nggak ada jadwal hari ini.';
    } else {
      const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
      for (const e of sorted) {
        const ts = format(e.start, 'HH:mm', { timeZone: tz });
        const te = format(e.end, 'HH:mm', { timeZone: tz });
        msg += `${ts} – ${te}\n${escapeHtml(e.summary)}\n\n`;
      }
    }
    return msg;
  }

  buildWeekSummary(events: CalendarEvent[], tz = 'Asia/Jakarta'): string {
    let msg = '📅 <b>This Week</b>\n\n';
    if (events.length === 0) {
      msg += '📭 Nggak ada jadwal minggu ini.';
    } else {
      // Kelompokkan per hari lokal user biar nggak muncul 2x buat hari sama.
      const byDay = new Map<string, CalendarEvent[]>();
      for (const e of events) {
        const key = format(e.start, 'yyyy-MM-dd', { timeZone: tz });
        const list = byDay.get(key) || [];
        list.push(e);
        byDay.set(key, list);
      }
      const sortedDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [day, list] of sortedDays) {
        const label = format(new Date(`${day}T00:00:00`), 'EEEE, dd MMM', { timeZone: tz });
        msg += `\n<b>${label}</b>\n`;
        list
          .sort((a, b) => a.start.getTime() - b.start.getTime())
          .forEach((e) => {
            const time = format(e.start, 'HH:mm', { timeZone: tz });
            msg += `${time} ${escapeHtml(e.summary)}\n`;
          });
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
