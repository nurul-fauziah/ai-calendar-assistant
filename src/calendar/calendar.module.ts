import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CalendarService } from './calendar.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [ConfigModule, CommonModule],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
