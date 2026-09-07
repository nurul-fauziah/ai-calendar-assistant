import { Module, forwardRef } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';
import { UsersModule } from '../users/users.module';
import { AiModule } from '../ai/ai.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [UsersModule, AiModule, forwardRef(() => SchedulerModule), CalendarModule],
  providers: [TelegramService],
  controllers: [TelegramController],
  exports: [TelegramService],
})
export class TelegramModule {}
