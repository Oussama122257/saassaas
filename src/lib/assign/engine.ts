import type { AssignmentSettings } from "@/lib/settings";

/**
 * Assignment engine (section 9.1), pure part. The DB layer (rules.ts) builds the candidate list;
 * this function decides. Strategies:
 *   LOAD_BALANCED — round-robin weighted by open load, capped per agent (default 40)
 *   PERCENTAGE    — supervisor-set % per agent; picks the agent furthest below their target share
 * Optional routing: high-value orders → top-rated agents; wilaya → preferred agents.
 */
export interface AgentCandidate {
  userId: string;
  podId: string | null;
  /** open confirmation orders currently assigned */
  openLoad: number;
  /** orders assigned since the distribution was saved (PERCENTAGE) */
  assignedSinceSaved: number;
  available: boolean;
  onShift: boolean;
  /** last assignment time (round-robin tie-break) */
  lastAssignedAt: number;
  /** delivery rate or QA based rating, 0..1 (higher is better) */
  rating?: number;
}

export interface AssignmentRequest {
  isHighValue: boolean;
  wilayaCode: number;
  /** agents that must not receive the order (previous owner on recycle / rotation) */
  exclude?: string[];
}

export type AssignmentDecision =
  | { ok: true; userId: string; podId: string | null; reason: string }
  | { ok: false; reason: "NO_AGENT_AVAILABLE" | "ALL_AT_CAPACITY" };

export function eligible(c: AgentCandidate, settings: AssignmentSettings, exclude: Set<string>): boolean {
  if (exclude.has(c.userId)) return false;
  if (!c.available) return false;
  if (settings.requireShift && !c.onShift) return false;
  return true;
}

export function chooseAgent(candidates: AgentCandidate[], req: AssignmentRequest, settings: AssignmentSettings): AssignmentDecision {
  const exclude = new Set(req.exclude ?? []);
  const pool = candidates.filter((c) => eligible(c, settings, exclude));
  if (pool.length === 0) return { ok: false, reason: "NO_AGENT_AVAILABLE" };
  const underCap = pool.filter((c) => c.openLoad < settings.maxOpenOrdersPerAgent);
  if (underCap.length === 0) return { ok: false, reason: "ALL_AT_CAPACITY" };

  let shortlist = underCap;
  let reason = settings.strategy;

  const preferred = settings.wilayaRouting[String(req.wilayaCode)];
  if (preferred && preferred.length > 0) {
    const routed = shortlist.filter((c) => preferred.includes(c.userId));
    if (routed.length > 0) {
      shortlist = routed;
      reason = "WILAYA_ROUTING" as typeof reason;
    }
  }
  if (req.isHighValue && settings.highValueToTopAgents) {
    const top = settings.topAgentIds.length > 0
      ? shortlist.filter((c) => settings.topAgentIds.includes(c.userId))
      : topRated(shortlist);
    if (top.length > 0) {
      shortlist = top;
      reason = "HIGH_VALUE_TOP_AGENT" as typeof reason;
    }
  }

  const pick = settings.strategy === "PERCENTAGE" && settings.distribution
    ? pickByPercentage(shortlist, settings.distribution.percents)
    : pickLoadBalanced(shortlist);
  if (!pick) return { ok: false, reason: "NO_AGENT_AVAILABLE" };
  return { ok: true, userId: pick.userId, podId: pick.podId, reason };
}

function topRated(list: AgentCandidate[]): AgentCandidate[] {
  const rated = list.filter((c) => typeof c.rating === "number");
  if (rated.length < 2) return [];
  const sorted = [...rated].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const cut = Math.max(1, Math.ceil(sorted.length / 2));
  return sorted.slice(0, cut);
}

/** Lowest open load wins; ties go to whoever was assigned least recently (round robin). */
export function pickLoadBalanced(list: AgentCandidate[]): AgentCandidate | undefined {
  return [...list].sort((a, b) => a.openLoad - b.openLoad || a.lastAssignedAt - b.lastAssignedAt || a.userId.localeCompare(b.userId))[0];
}

/**
 * Percentage distribution: the agent with the largest deficit between their target share and
 * what they actually received since the distribution was saved. Agents with 0 % never receive.
 */
export function pickByPercentage(list: AgentCandidate[], percents: Record<string, number>): AgentCandidate | undefined {
  const withShare = list.filter((c) => (percents[c.userId] ?? 0) > 0);
  if (withShare.length === 0) return undefined;
  const totalPct = withShare.reduce((a, c) => a + (percents[c.userId] ?? 0), 0);
  const assigned = withShare.reduce((a, c) => a + c.assignedSinceSaved, 0) + 1;
  return [...withShare].sort((a, b) => {
    const da = ((percents[a.userId] ?? 0) / totalPct) * assigned - a.assignedSinceSaved;
    const db = ((percents[b.userId] ?? 0) / totalPct) * assigned - b.assignedSinceSaved;
    return db - da || a.lastAssignedAt - b.lastAssignedAt;
  })[0];
}

/** Validate a percentage distribution before saving: must total 100. */
export function validateDistribution(percents: Record<string, number>): { ok: true } | { ok: false; total: number } {
  const total = Object.values(percents).reduce((a, b) => a + b, 0);
  return Math.abs(total - 100) < 0.001 ? { ok: true } : { ok: false, total };
}

/** Is `date` inside one of the user's shifts? (weekday 0 = Sunday, minutes in org tz) */
export function isOnShift(shifts: Array<{ weekday: number; startMin: number; endMin: number }>, weekday: number, minute: number): boolean {
  return shifts.some((s) => s.weekday === weekday && minute >= s.startMin && minute < s.endMin);
}
