import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async getPreferences(userId: string) {
    return this.prisma.userPreference.findUnique({
      where: { userId },
    });
  }

  async setPreferences(userId: string, data: {
    preferredStart?: number;
    preferredEnd?: number;
    maxDailyHours?: number;
  }) {
    return this.prisma.userPreference.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
  }
}
