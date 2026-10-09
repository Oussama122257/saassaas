import type { CallSlot } from "@prisma/client";
import type { CallSettings, MinuteWindow } from "@/lib/settings";
import { dateKeyInTz, zonedParts } from "@/lib/time";

/**
 * Call cadence (section 8): 3 attempts per day × 3 days, slot windows, blocked windows and
 * minimum spacing. Pure functions — the transition service validates with them and the scheduler
 * plans `nextActionAt` with them.
 *
 *   Day 1: attempt 1 within 15 min of the order · attempt 2 after the cadence gap · attempt 3 evening
 *   Day 2/3: morning · afternoon · evening
 */

export type BlockReason = "BEFORE_HOURS" | "AFTER_HOURS" | "PRAYER" | "FRIDAY_MIDDAY";
export type AttemptRejection =
  | "FUTURE_ATTEMPT"
  | "BLOCKED_WINDOW"
  | "MIN_GAP"
  | "OUTSIDE_SLOT"
  | "SAME_CALENDAR_DAY"
  | "MAX_ATTEMPTS";

export const SLOT_ORDER: CallSlot[] = ["MORNING", "AFTERNOON", "EVENING"];

function inWindow(minute: number, w: MinuteWindow): boolean {
  return minute >= w[0] && minute < w[1];
}

/** Coarse slot of a time of day: morning < 13:00 ≤ afternoon < 17:00 ≤ evening. */
export function slotOfMinute(minute: number): CallSlot {
  if (minute < 13 * 60) return "MORNING";
  if (minute < 17 * 60) return "AFTERNOON";
  return "EVENING";
}

export function slotOf(date: Date, tz: string): CallSlot {
  const p = zonedParts(date, tz);
  return slotOfMinute(p.hour * 60 + p.minute);
}

/** Why calling is not allowed at `date` (null = allowed). */
export function blockedReason(date: Date, cfg: CallSettings, tz: string): BlockReason | null {
  const p = zonedParts(date, tz);
  const minute = p.hour * 60 + p.minute;
  if (minute < cfg.dayStartMin) return "BEFORE_HOURS";
  if (minute >= cfg.dayEndMin) return "AFTER_HOURS";
  if (cfg.prayerWindows.some((w) => inWindow(minute, w))) return "PRAYER";
  if (p.weekday === 5 && cfg.fridayBlock && inWindow(minute, cfg.fridayBlock)) return "FRIDAY_MIDDAY";
  return null;
}

export function isBlocked(date: Date, cfg: CallSettings, tz: string): boolean {
  return blockedReason(date, cfg, tz) !== null;
}

/** Attempt number (1-based, within the round) → day (1..3) and position in the day (1..3). */
export function attemptPosition(attemptNo: number): { day: number; position: number } {
  return { day: Math.ceil(attemptNo / 3), position: ((attemptNo - 1) % 3) + 1 };
}

/** The slot an attempt must fall in, or null when any allowed time is fine (day 1, attempts 1–2). */
export function expectedSlot(attemptNo: number): CallSlot | null {
  const { day, position } = attemptPosition(attemptNo);
  if (day === 1) return position === 3 ? "EVENING" : null;
  return SLOT_ORDER[position - 1] ?? null;
}

export interface AttemptCheckInput {
  /** attempt number in the current round (1-based) */
  attemptNo: number;
  startedAt: Date;
  /** startedAt of the previous attempts of this round, oldest first */
  previous: Date[];
  /** all attempts on the order across rounds (cap) */
  totalAttempts: number;
  cfg: CallSettings;
  tz: string;
  now?: Date;
}

/** Validate an attempt against the cadence rules. Returns the first rejection, or null if valid. */
export function checkAttempt(input: AttemptCheckInput): AttemptRejection | null {
  const { attemptNo, startedAt, previous, cfg, tz } = input;
  const now = input.now ?? new Date();
  if (attemptNo > cfg.maxAttemptsPerRound || input.totalAttempts >= cfg.maxAttemptsTotal) return "MAX_ATTEMPTS";
  if (startedAt.getTime() > now.getTime() + 5 * 60_000) return "FUTURE_ATTEMPT";
  if (isBlocked(startedAt, cfg, tz)) return "BLOCKED_WINDOW";
  const last = previous[previous.length - 1];
  if (last && startedAt.getTime() - last.getTime() < cfg.minAttemptGapMin * 60_000) return "MIN_GAP";
  if (cfg.strictSlots) {
    const slot = expectedSlot(attemptNo);
    if (slot) {
      const p = zonedParts(startedAt, tz);
      const minute = p.hour * 60 + p.minute;
      if (!inWindow(minute, cfg.slots[slot])) return "OUTSIDE_SLOT";
    }
    // the first attempt of day 2 / day 3 happens on a later calendar day than the previous attempt
    const { day, position } = attemptPosition(attemptNo);
    if (day > 1 && position === 1 && last && dateKeyInTz(last, tz) === dateKeyInTz(startedAt, tz)) return "SAME_CALENDAR_DAY";
  }
  return null;
}

const STEP_MS = 5 * 60_000;

/**
 * Earliest valid time for the next attempt (attemptNo = attempts done + 1), searching forward in
 * 5-minute steps for up to 7 days. Day 1 attempt 1 targets the order time; later attempts respect
 * the cadence gap, slot windows and blocked windows.
 */
export function planAttempt(input: {
  attemptNo: number;
  previous: Date[];
  orderCreatedAt: Date;
  cfg: CallSettings;
  tz: string;
  notBefore?: Date;
}): Date {
  const { attemptNo, previous, cfg, tz } = input;
  const last = previous[previous.length - 1];
  let start = last ? new Date(last.getTime() + Math.max(cfg.cadenceGapMin, cfg.minAttemptGapMin) * 60_000) : input.orderCreatedAt;
  if (input.notBefore && input.notBefore > start) start = input.notBefore;
  // align to the 5-minute grid
  let t = Math.ceil(start.getTime() / STEP_MS) * STEP_MS;
  const limit = t + 7 * 24 * 3600_000;
  for (; t <= limit; t += STEP_MS) {
    const candidate = new Date(t);
    const rejection = checkAttempt({ attemptNo, startedAt: candidate, previous, totalAttempts: 0, cfg, tz, now: new Date(limit) });
    if (!rejection) return candidate;
  }
  return new Date(limit);
}

/**
 * "Properly spaced" attempts (section 19c.1): attempts at least the minimum gap after the
 * previous one, and how many distinct slots they cover.
 */
export function spacedAttemptStats(dates: Date[], cfg: CallSettings, tz: string): { spaced: number; slots: number } {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  let spaced = 0;
  const slots = new Set<string>();
  let prev: Date | null = null;
  for (const d of sorted) {
    if (!prev || d.getTime() - prev.getTime() >= cfg.minAttemptGapMin * 60_000) {
      spaced++;
      slots.add(slotOf(d, tz));
      prev = d;
    }
  }
  return { spaced, slots: slots.size };
}

export function hasEnoughSpacedAttempts(dates: Date[], cfg: CallSettings, tz: string): boolean {
  const s = spacedAttemptStats(dates, cfg, tz);
  if (cfg.minSpacedAttemptsToClose === 0) return true;
  return s.spaced >= cfg.minSpacedAttemptsToClose && s.slots >= cfg.minSlotsToClose;
}

/** Retries logged less than `fastRetryMin` after the previous attempt on the same order. */
export function fastRetryCount(dates: Date[], fastRetryMin: number): { retries: number; fast: number } {
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  let fast = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.getTime() - sorted[i - 1]!.getTime() < fastRetryMin * 60_000) fast++;
  }
  return { retries: Math.max(0, sorted.length - 1), fast };
}
