import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { User } from '../../generated/prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByTelegramId(telegramId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }

  async create(telegramId: string, name?: string): Promise<User> {
    return this.prisma.user.create({
      data: { telegramId, name: name ?? null },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
