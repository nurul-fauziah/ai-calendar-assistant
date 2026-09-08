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
  recurrence?: string;
}
