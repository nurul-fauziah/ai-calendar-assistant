export enum Priority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export type TimePreference = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | null;

export interface ParsedTask {
  intent: 'CREATE_TASK' | 'RESCHEDULE' | 'CANCEL' | 'UNKNOWN';
  title?: string;
  durationMinutes?: number;
  deadline?: string;
  priority?: Priority;
  preferredTime?: TimePreference;
  /** Jam mulai spesifik yang user minta (0-23), mis. "jam 1 siang" = 13. */
  preferredHour?: number;
  /** Menit mulai spesifik (0-1439) — presisi penuh "11:50". null/undefined = user nggak minta jam. */
  preferredMinutes?: number;
  date?: string;
  /** Label recurrence legacy ("daily"|"weekly"|"monthly") — dipakai buat deteksi dulu/back-compat. */
  recurrence?: string;
  /** RFC-5545 RRULE, mis. "FREQ=WEEKLY;BYDAY=MO;BYHOUR=7". null/undefined = one-off. */
  recurrenceRule?: string;
  /** Hari dalam minggu buat pola "setiap senin" — 1=Senin..7=Minggu (ISO). */
  recurrenceWeekday?: number;
  /** Tanggal bulanan buat "setiap tanggal 1" (1-31). */
  recurrenceMonthDay?: number;
}

/** Normalized recurrence descriptor dari parser → dipakai scheduler. */
export interface RecurrenceDescriptor {
  /** RFC-5545 RRULE, mis. "FREQ=WEEKLY;BYDAY=MO;BYHOUR=7". */
  rrule: string;
  /** Fase: user udah kasih jam → "COMPLETE"; belum → butuh klarifikasi. */
  needsTime: boolean;
  /** Nilai awal preferredMinutes kalau user sudah kasih waktu, else undefined. */
  preferredMinutes?: number;
  /** Hari ISO 1..7 kalau weekly. */
  weekday?: number;
  /** Tanggal 1..31 kalau monthly. */
  monthDay?: number;
}
