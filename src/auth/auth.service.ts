import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { encryptToken } from '../common/crypto.util';
import { UsersService } from '../users/users.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
    this.redirectUri = config.get<string>('GOOGLE_REDIRECT_URI') ?? '';
  }

  getAuthUrl(telegramId: string): string {
    const state = Buffer.from(`${telegramId}`).toString('base64');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<string> {
    const telegramId = Buffer.from(state, 'base64').toString();
    const user = await this.users.findByTelegramId(telegramId);
    if (!user) {
      throw new Error('User not found');
    }

    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    });

    const { access_token, refresh_token, expires_in = 3600 } = tokenRes.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    const encKey = this.config.get<string>('TOKEN_ENCRYPTION_KEY');

    // Save connection — token dienkripsi di rest (AES-256-GCM)
    await this.prisma.googleConnection.upsert({
      where: { userId: user.id },
      update: {
        accessToken: encryptToken(access_token, encKey),
        refreshToken: encryptToken(refresh_token, encKey),
        expiresAt,
      },
      create: {
        userId: user.id,
        accessToken: encryptToken(access_token, encKey),
        refreshToken: encryptToken(refresh_token, encKey),
        expiresAt,
      },
    });

    return `✅ Google Calendar berhasil terhubung, ${user.name || user.telegramId}!`;
  }
}
