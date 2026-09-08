import { format, fromZonedTime, toZonedTime } from 'date-fns-tz';

// Helper timezone. `Date` JS selalu absolute (UTC ms); semua interprtasi
// jam/detik harus lewat zona user biar "jam 13" = 13:00 WIB, bukan UTC.

// "YYYY-MM-DD" (lokal user) → Date absolute utk tengah malam di zona itu.
export function localDateToUtc(dateStr: string, tz: string): Date {
  return fromZonedTime(`${dateStr}T00:00:00`, tz);
}

// "YYYY-MM-DD" lokal user dari Date absolute.
export function utcToLocalDateStr(date: Date, tz: string): string {
  return format(date, 'yyyy-MM-dd', { timeZone: tz });
}

// Date absolute → wall-clock di zona user (getHours/getDate ikut zona).
// Dipakai utk iterasi hari & baca jam lokal.
export function toLocal(date: Date, tz: string): Date {
  return toZonedTime(date, tz);
}

// Format jam "HH:mm" di zona user dari Date absolute.
export function localTime(date: Date, tz: string): string {
  return format(date, 'HH:mm', { timeZone: tz });
}

// Format tanggal lokal user.
export function localDateHuman(date: Date, tz: string): Date {
  return toZonedTime(date, tz);
}

export { format as formatTz };
