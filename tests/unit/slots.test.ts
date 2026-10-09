import { describe, expect, it } from "vitest";
import { blockedReason, checkAttempt, expectedSlot, fastRetryCount, hasEnoughSpacedAttempts, planAttempt, spacedAttemptStats } from "@/lib/calls/slots";
import { DEFAULT_ORG_SETTINGS } from "@/lib/settings";
import { zonedDate } from "@/lib/time";

const cfg = DEFAULT_ORG_SETTINGS.calls;
const tz = "Africa/Algiers";
// Monday 28 Sep 2026 (weekday 1) and Friday 2 Oct 2026, local times
const mon = (h: number, m = 0, dayOffset = 0) => zonedDate(2026, 9, 28 + dayOffset, h, m, 0, tz);
const now = zonedDate(2026, 10, 9, 12, 0, 0, tz);

describe("call slots (section 8)", () => {
  it("blocks before 09:00, after 21:00, prayer windows and Friday midday", () => {
    expect(blockedReason(mon(8, 59), cfg, tz)).toBe("BEFORE_HOURS");
    expect(blockedReason(mon(9, 0), cfg, tz)).toBeNull();
    expect(blockedReason(mon(21, 0), cfg, tz)).toBe("AFTER_HOURS");
    expect(blockedReason(mon(12, 50), cfg, tz)).toBe("PRAYER");
    expect(blockedReason(zonedDate(2026, 10, 2, 13, 30, 0, tz), cfg, tz)).toBe("FRIDAY_MIDDAY");
    expect(blockedReason(zonedDate(2026, 10, 2, 11, 0, 0, tz), cfg, tz)).toBeNull();
  });

  it("knows the slot of each attempt: day 1 free then evening; days 2–3 morning/afternoon/evening", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(expectedSlot)).toEqual([null, null, "EVENING", "MORNING", "AFTERNOON", "EVENING", "MORNING", "AFTERNOON", "EVENING"]);
  });

  it("rejects an attempt 1 minute after the previous one (hard minimum spacing)", () => {
    expect(checkAttempt({ attemptNo: 2, startedAt: mon(10, 1), previous: [mon(10, 0)], totalAttempts: 1, cfg, tz, now })).toBe("MIN_GAP");
    expect(checkAttempt({ attemptNo: 2, startedAt: mon(10, 30), previous: [mon(10, 0)], totalAttempts: 1, cfg, tz, now })).toBeNull();
  });

  it("rejects attempts outside their slot, in blocked windows, on the same calendar day for a new day, or in the future", () => {
    expect(checkAttempt({ attemptNo: 3, startedAt: mon(15, 0), previous: [mon(9, 10), mon(11, 30)], totalAttempts: 2, cfg, tz, now })).toBe("OUTSIDE_SLOT");
    expect(checkAttempt({ attemptNo: 3, startedAt: mon(18, 30), previous: [mon(9, 10), mon(11, 30)], totalAttempts: 2, cfg, tz, now })).toBeNull();
    expect(checkAttempt({ attemptNo: 4, startedAt: mon(10, 30, 1), previous: [mon(9, 10), mon(11, 30), mon(18, 30)], totalAttempts: 3, cfg, tz, now })).toBeNull();
    expect(checkAttempt({ attemptNo: 4, startedAt: mon(14, 30, 1), previous: [mon(9, 10), mon(11, 30), mon(18, 30)], totalAttempts: 3, cfg, tz, now })).toBe("OUTSIDE_SLOT");
    expect(checkAttempt({ attemptNo: 1, startedAt: mon(22, 0), previous: [], totalAttempts: 0, cfg, tz, now })).toBe("BLOCKED_WINDOW");
    expect(checkAttempt({ attemptNo: 1, startedAt: new Date(now.getTime() + 3600_000), previous: [], totalAttempts: 0, cfg, tz, now })).toBe("FUTURE_ATTEMPT");
    expect(checkAttempt({ attemptNo: 10, startedAt: mon(10, 0, 5), previous: [], totalAttempts: 9, cfg, tz, now })).toBe("MAX_ATTEMPTS");
    expect(checkAttempt({ attemptNo: 1, startedAt: mon(10, 0, 5), previous: [], totalAttempts: 12, cfg, tz, now })).toBe("MAX_ATTEMPTS");
  });

  it("plans the 3×3 cadence with valid times only", () => {
    const created = mon(9, 0);
    const times: Date[] = [];
    for (let i = 1; i <= 9; i++) {
      const t = planAttempt({ attemptNo: i, previous: [...times], orderCreatedAt: created, cfg, tz });
      expect(checkAttempt({ attemptNo: i, startedAt: t, previous: times, totalAttempts: i - 1, cfg, tz, now })).toBeNull();
      times.push(t);
    }
    expect(times[0]).toEqual(mon(9, 0));
    expect(times[2]!.getTime()).toBeGreaterThanOrEqual(mon(18, 0).getTime());
    expect(times[3]).toEqual(mon(10, 0, 1)); // day 2 morning
    expect(hasEnoughSpacedAttempts(times, cfg, tz)).toBe(true);
  });

  it("counts properly spaced attempts and fast retries", () => {
    const fast = [mon(10, 0), mon(10, 1), mon(10, 2)];
    expect(spacedAttemptStats(fast, cfg, tz)).toEqual({ spaced: 1, slots: 1 });
    expect(hasEnoughSpacedAttempts(fast, cfg, tz)).toBe(false);
    expect(fastRetryCount(fast, 3)).toEqual({ retries: 2, fast: 2 });
    const evening = [mon(18, 0), mon(18, 40), mon(19, 30)];
    expect(spacedAttemptStats(evening, cfg, tz)).toEqual({ spaced: 3, slots: 1 }); // 3 spaced, but one slot only
    expect(hasEnoughSpacedAttempts(evening, cfg, tz)).toBe(false);
  });
});
