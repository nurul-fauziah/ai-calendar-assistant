import { Module } from '@nestjs/common';
import { PreferencesService } from './preferences.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
