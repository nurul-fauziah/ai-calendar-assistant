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
  date?: string;
  recurrence?: string;
}
