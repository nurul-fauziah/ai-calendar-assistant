import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async health() {
    const status: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };

    // DB check
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      status.db = 'connected';
    } catch (err) {
      status.db = 'error';
      status.status = 'degraded';
    }

    // Telegram bot configured
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    status.telegram = token ? 'configured' : 'not_configured';

    // LLM configured
    const llmKey = this.config.get<string>('LLM_API_KEY');
    status.llm = llmKey ? 'configured' : 'fallback_regex';

    // Google Calendar configured
    const gcp = this.config.get<string>('GOOGLE_CLIENT_ID');
    status.google_calendar = gcp ? 'configured' : 'not_configured';

    return status;
  }
}
