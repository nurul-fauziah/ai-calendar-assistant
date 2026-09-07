import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TelegramModule } from './telegram/telegram.module';
import { AiModule } from './ai/ai.module';
import { TasksModule } from './tasks/tasks.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { CalendarModule } from './calendar/calendar.module';
import { PreferencesModule } from './preferences/preferences.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    AuthModule,
    UsersModule,
    TelegramModule,
    AiModule,
    TasksModule,
    SchedulerModule,
    CalendarModule,
    PreferencesModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
