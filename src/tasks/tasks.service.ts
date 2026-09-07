import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { Task, TaskStatus, TaskPriority } from '../../generated/prisma/client';
import { ParsedTask } from '../ai/ai.interface';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async createTask(userId: string, parsed: ParsedTask): Promise<Task> {
    return this.prisma.task.create({
      data: {
        userId,
        title: parsed.title || 'Untitled',
        description: parsed.recurrence ? `Repeats: ${parsed.recurrence}` : undefined,
        durationMinutes: parsed.durationMinutes || 60,
        deadline: parsed.deadline ? new Date(parsed.deadline) : null,
        priority: (parsed.priority || 'NORMAL') as TaskPriority,
        status: TaskStatus.PENDING,
      },
    });
  }

  async getUserTasks(userId: string, deadline?: Date) {
    return this.prisma.task.findMany({
      where: {
        userId,
        status: TaskStatus.PENDING,
        ...(deadline ? { deadline: { lte: deadline } } : {}),
      },
      orderBy: { deadline: deadline ? 'asc' : 'desc' },
    });
  }

  async updateScheduledTask(taskId: string, schedule: { startTime: Date; endTime: Date; calendarEventId?: string }) {
    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: TaskStatus.SCHEDULED },
    });

    await this.prisma.scheduledTask.create({
      data: {
        taskId,
        userId: task.userId,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
        calendarEventId: schedule.calendarEventId,
        status: TaskStatus.SCHEDULED,
      },
    });

    return task;
  }
}
