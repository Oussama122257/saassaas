import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** DZD amounts are integers; format with a thin space and the currency suffix. */
export function formatDzd(amount: number, locale = "fr"): string {
  const n = new Intl.NumberFormat(locale.startsWith("ar") ? "ar-DZ" : "fr-DZ", { maximumFractionDigits: 0 }).format(amount);
  return locale.startsWith("ar") ? `${n} دج` : `${n} DA`;
}

export function formatDateTime(date: Date | string | null | undefined, locale = "fr", tz = "Africa/Algiers"): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale.startsWith("ar") ? "ar-DZ" : "fr-DZ", {
    timeZone: tz,
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}

export function formatDate(date: Date | string | null | undefined, locale = "fr", tz = "Africa/Algiers"): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale.startsWith("ar") ? "ar-DZ" : "fr-DZ", { timeZone: tz, dateStyle: "medium" }).format(d);
}

export function relativeTime(date: Date | string, locale = "fr", now = new Date()): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale.startsWith("ar") ? "ar" : "fr", { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}
