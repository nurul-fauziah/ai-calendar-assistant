export interface AvailableSlot {
  start: Date;
  end: Date;
  availableMinutes: number;
}

export interface ScheduleItem {
  taskId: string;
  title: string;
  start: Date;
  end: Date;
}

export interface ScheduleRecommendation {
  items: ScheduleItem[];
  totalMinutes: number;
  deadline?: Date;
}
