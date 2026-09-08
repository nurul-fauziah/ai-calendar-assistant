import { Module, forwardRef } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { CommonModule } from '../common/common.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TelegramModule } from '../telegram/telegram.module';
import { TasksModule } from '../tasks/tasks.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [CommonModule, CalendarModule, TasksModule, forwardRef(() => TelegramModule), AiModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
