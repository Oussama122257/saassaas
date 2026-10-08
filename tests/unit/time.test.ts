import { describe, expect, it } from "vitest";
import { dateKeyInTz, endOfDayInTz, minutesSinceMidnightInTz, startOfDayInTz, zonedParts } from "@/lib/time";

describe("time helpers (Africa/Algiers = UTC+1, no DST)", () => {
  const at = new Date("2026-10-08T22:30:00.000Z"); // 23:30 local
  it("reads wall-clock parts in the org timezone", () => {
    const p = zonedParts(at, "Africa/Algiers");
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 10, 8, 23, 30]);
    expect(minutesSinceMidnightInTz(at)).toBe(23 * 60 + 30);
    expect(dateKeyInTz(at)).toBe("2026-10-08");
    expect(dateKeyInTz(new Date("2026-10-08T23:30:00.000Z"))).toBe("2026-10-09");
  });
  it("computes day boundaries in local time", () => {
    expect(startOfDayInTz(at).toISOString()).toBe("2026-10-07T23:00:00.000Z");
    expect(endOfDayInTz(at).toISOString()).toBe("2026-10-08T22:59:59.999Z");
  });
});
