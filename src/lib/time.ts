/**
 * Small timezone helpers (no dependency). All scheduling happens in the org timezone,
 * default Africa/Algiers (UTC+1, no DST).
 */
export const DEFAULT_TZ = "Africa/Algiers";

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(date: Date, tz: string = DEFAULT_TZ): Parts {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** Offset of `tz` relative to UTC at `date`, in milliseconds. */
export function tzOffsetMs(date: Date, tz: string = DEFAULT_TZ): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Build an instant from wall-clock components in `tz`. */
export function zonedDate(y: number, m: number, d: number, h = 0, min = 0, s = 0, tz: string = DEFAULT_TZ): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min, s));
  const offset = tzOffsetMs(guess, tz);
  return new Date(guess.getTime() - offset);
}

export function startOfDayInTz(date: Date, tz: string = DEFAULT_TZ): Date {
  const p = zonedParts(date, tz);
  return zonedDate(p.year, p.month, p.day, 0, 0, 0, tz);
}

export function endOfDayInTz(date: Date, tz: string = DEFAULT_TZ): Date {
  return new Date(startOfDayInTz(date, tz).getTime() + 24 * 60 * 60 * 1000 - 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function minutesSinceMidnightInTz(date: Date, tz: string = DEFAULT_TZ): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "YYYY-MM-DD" in the org timezone (used to group attempts per day). */
export function dateKeyInTz(date: Date, tz: string = DEFAULT_TZ): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
