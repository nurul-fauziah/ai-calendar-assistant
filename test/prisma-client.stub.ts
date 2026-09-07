// Jest loads generated/prisma/client.js which is ESM (import.meta) and breaks
// the CommonJS ts-jest transform. Tests mock every Prisma method anyway, so a
// stub class is enough.
export class PrismaClient {}
export namespace Prisma {
  export type ScheduledTaskWhereUniqueInput = Record<string, unknown>;
}