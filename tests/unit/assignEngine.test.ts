import { describe, expect, it } from "vitest";
import { chooseAgent, isOnShift, pickByPercentage, validateDistribution, type AgentCandidate } from "@/lib/assign/engine";
import { DEFAULT_ORG_SETTINGS } from "@/lib/settings";

const base = DEFAULT_ORG_SETTINGS.assignment;
const agent = (userId: string, over: Partial<AgentCandidate> = {}): AgentCandidate => ({ userId, podId: "p1", openLoad: 0, assignedSinceSaved: 0, available: true, onShift: true, lastAssignedAt: 0, ...over });

describe("assignment engine (section 9.1)", () => {
  it("picks the lowest open load, round-robin on ties", () => {
    const r = chooseAgent([agent("a", { openLoad: 5 }), agent("b", { openLoad: 2 }), agent("c", { openLoad: 2, lastAssignedAt: 10 })], { isHighValue: false, wilayaCode: 16 }, base);
    expect(r).toMatchObject({ ok: true, userId: "b" });
  });

  it("skips unavailable, off-shift, excluded and capped agents", () => {
    const list = [agent("a", { available: false }), agent("b", { onShift: false }), agent("c"), agent("d", { openLoad: 40 })];
    expect(chooseAgent(list, { isHighValue: false, wilayaCode: 16, exclude: ["c"] }, base)).toEqual({ ok: false, reason: "ALL_AT_CAPACITY" });
    expect(chooseAgent(list, { isHighValue: false, wilayaCode: 16 }, base)).toMatchObject({ ok: true, userId: "c" });
    expect(chooseAgent([agent("a", { available: false })], { isHighValue: false, wilayaCode: 16 }, base)).toEqual({ ok: false, reason: "NO_AGENT_AVAILABLE" });
  });

  it("routes high-value orders to top-rated agents and honours wilaya routing", () => {
    const list = [agent("a", { rating: 0.3 }), agent("b", { rating: 0.8, openLoad: 10 }), agent("c", { rating: 0.5 })];
    expect(chooseAgent(list, { isHighValue: true, wilayaCode: 16 }, base)).toMatchObject({ userId: "c", reason: "HIGH_VALUE_TOP_AGENT" });
    expect(chooseAgent(list, { isHighValue: false, wilayaCode: 31 }, { ...base, wilayaRouting: { "31": ["b"] } })).toMatchObject({ userId: "b", reason: "WILAYA_ROUTING" });
  });

  it("percentage distribution follows the target shares", () => {
    const percents = { a: 50, b: 30, c: 20 };
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 100; i++) {
      const pick = pickByPercentage(["a", "b", "c"].map((id) => agent(id, { assignedSinceSaved: counts[id]! })), percents)!;
      counts[pick.userId]!++;
    }
    expect(counts).toEqual({ a: 50, b: 30, c: 20 });
    expect(pickByPercentage([agent("x")], { x: 0 })).toBeUndefined();
    expect(validateDistribution({ a: 60, b: 30 })).toEqual({ ok: false, total: 90 });
    expect(validateDistribution(percents)).toEqual({ ok: true });
  });

  it("shift check uses weekday + minutes", () => {
    const shifts = [{ weekday: 1, startMin: 540, endMin: 1020 }];
    expect(isOnShift(shifts, 1, 600)).toBe(true);
    expect(isOnShift(shifts, 1, 1020)).toBe(false);
    expect(isOnShift(shifts, 2, 600)).toBe(false);
  });
});
