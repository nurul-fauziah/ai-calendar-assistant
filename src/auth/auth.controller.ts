import { Controller, Get, Query, Res, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('google')
  googleLogin(@Query('telegramId') telegramId: string, @Res() res: Response) {
    // Telegram IDs are positive ints; reject junk instead of flowing it into
    // the OAuth state.
    if (!telegramId || !/^\d{6,15}$/.test(telegramId)) {
      throw new BadRequestException('Invalid telegramId');
    }
    const url = this.authService.getAuthUrl(telegramId);
    res.redirect(url);
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: any,
  ) {
    try {
      const msg = await this.authService.handleCallback(code, state);
      res.send(
        `<html><body><h3>${msg}</h3><p style="color:green">Kamu bisa kembali ke Telegram sekarang.</p></body></html>`,
      );
    } catch {
      res.status(500).send('<h3>Gagal koneksi Google.</h3>');
    }
  }
}
