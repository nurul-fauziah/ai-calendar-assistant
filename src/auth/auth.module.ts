import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { CommonModule } from '../common/common.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [ConfigModule, CommonModule, UsersModule],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
