import {
  Controller,
  Post,
  Body,
  Logger,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';
import type { TelegramUpdate } from './telegram.interface';

@Controller('webhook')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly config: ConfigService,
  ) {}

  @Post('telegram')
  async handleTelegram(
    @Body() update: TelegramUpdate,
    @Headers('X-Telegram-Bot-Api-Secret-Token') secret: string | undefined,
  ) {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (expected && secret !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    const msg = update.message;
    const cb = update.callback_query;
    if (msg?.text) {
      this.logger.log(`Telegram msg from ${msg.from?.id}: ${msg.text}`);
    } else if (cb?.data) {
      this.logger.log(`Telegram callback: ${cb.data} from ${cb.from?.id}`);
    } else {
      this.logger.log('Telegram update (no text/callback)');
    }
    return this.telegram.handleUpdate(update);
  }
}
