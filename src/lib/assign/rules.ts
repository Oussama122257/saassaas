import type { Prisma } from "@prisma/client";
import { prisma, withSystemContext, type DbClient } from "@/lib/db";
import { assignOrder, loadOpsContext, transitionOrder } from "@/lib/orders/orderTransitions";
import { CONFIRMATION_OPEN_STATUSES, FINISHED_PARCEL_STATUSES, DELIVERED_STATUSES } from "@/lib/orders/statuses";
import { systemContext } from "@/lib/tenant";
import { parseOrgSettings, type AssignmentSettings } from "@/lib/settings";
import { addDays, zonedParts } from "@/lib/time";
import { chooseAgent, isOnShift, type AgentCandidate, type AssignmentDecision } from "./engine";

/**
 * Assignment engine, DB side (section 9). Builds the candidate list for a merchant from the pods
 * that serve it (PodMerchant), then lets engine.ts decide.
 */

export interface PodAgent {
  userId: string;
  podId: string;
  orgId: string;
  availability: "AVAILABLE" | "BREAK" | "OFFLINE";
  lastAssignedAt: Date | null;
}

/** Confirmation agents of the pods serving a merchant (optionally a single pod). */
export async function podAgentsForMerchant(db: DbClient, merchantId: string, podId?: string | null): Promise<PodAgent[]> {
  const pods = await db.podMerchant.findMany({
    where: { merchantId, ...(podId ? { podId } : {}), pod: { active: true } },
    select: { pod: { select: { id: true, orgId: true, members: { where: { active: true, role: "CONFIRMATION_AGENT" }, select: { userId: true, availability: true, lastAssignedAt: true } } } } },
  });
  const out: PodAgent[] = [];
  for (const pm of pods) {
    for (const m of pm.pod.members) out.push({ userId: m.userId, podId: pm.pod.id, orgId: pm.pod.orgId, availability: m.availability, lastAssignedAt: m.lastAssignedAt });
  }
  return out;
}

export async function shiftsByUser(db: DbClient, userIds: string[]): Promise<Map<string, Array<{ weekday: number; startMin: number; endMin: number }>>> {
  const rows = await db.shift.findMany({ where: { userId: { in: userIds }, orgId: { not: "" } }, select: { userId: true, weekday: true, startMin: true, endMin: true } });
  const map = new Map<string, Array<{ weekday: number; startMin: number; endMin: number }>>();
  for (const r of rows) {
    const list = map.get(r.userId) ?? [];
    list.push(r);
    map.set(r.userId, list);
  }
  return map;
}

export function onShiftAt(shifts: Array<{ weekday: number; startMin: number; endMin: number }> | undefined, now: Date, tz: string): boolean {
  if (!shifts || shifts.length === 0) return false;
  const p = zonedParts(now, tz);
  return isOnShift(shifts, p.weekday, p.hour * 60 + p.minute);
}

export async function buildCandidates(db: DbClient, params: { merchantId: string; podId?: string | null; settings: AssignmentSettings; tz: string; now?: Date }): Promise<AgentCandidate[]> {
  const now = params.now ?? new Date();
  const agents = await podAgentsForMerchant(db, params.merchantId, params.podId);
  if (agents.length === 0) return [];
  const ids = [...new Set(agents.map((a) => a.userId))];
  const [loads, shifts, finished, delivered] = await Promise.all([
    db.order.groupBy({ by: ["assignedToId"], where: { assignedToId: { in: ids }, status: { in: CONFIRMATION_OPEN_STATUSES }, merchantId: { not: "" } }, _count: { _all: true } }),
    shiftsByUser(db, ids),
    db.order.groupBy({ by: ["confirmedById"], where: { confirmedById: { in: ids }, status: { in: FINISHED_PARCEL_STATUSES }, confirmedAt: { gte: addDays(now, -30) }, merchantId: { not: "" } }, _count: { _all: true } }),
    db.order.groupBy({ by: ["confirmedById"], where: { confirmedById: { in: ids }, status: { in: DELIVERED_STATUSES }, confirmedAt: { gte: addDays(now, -30) }, merchantId: { not: "" } }, _count: { _all: true } }),
  ]);
  const loadOf = new Map(loads.map((l) => [l.assignedToId, l._count._all]));
  const finOf = new Map(finished.map((l) => [l.confirmedById, l._count._all]));
  const delOf = new Map(delivered.map((l) => [l.confirmedById, l._count._all]));

  let sinceSaved = new Map<string, number>();
  const dist = params.settings.distribution;
  if (params.settings.strategy === "PERCENTAGE" && dist) {
    const since = new Date(dist.savedAt);
    const events = await db.orderEvent.findMany({
      where: { createdAt: { gte: since }, type: { in: ["STATUS_CHANGE", "ASSIGN", "REASSIGN", "RECYCLE"] }, order: { merchantId: { not: "" } }, OR: [{ toStatus: "ASSIGNEE" }, { type: { in: ["ASSIGN", "REASSIGN"] } }] },
      select: { payload: true },
    });
    sinceSaved = new Map();
    for (const e of events) {
      const p = e.payload as { assignedToId?: string; toUserId?: string };
      const uid = p.assignedToId ?? p.toUserId;
      if (uid) sinceSaved.set(uid, (sinceSaved.get(uid) ?? 0) + 1);
    }
  }

  const seen = new Set<string>();
  const out: AgentCandidate[] = [];
  for (const a of agents) {
    if (seen.has(a.userId)) continue;
    seen.add(a.userId);
    const fin = finOf.get(a.userId) ?? 0;
    out.push({
      userId: a.userId,
      podId: a.podId,
      openLoad: loadOf.get(a.userId) ?? 0,
      assignedSinceSaved: sinceSaved.get(a.userId) ?? 0,
      available: a.availability === "AVAILABLE",
      onShift: onShiftAt(shifts.get(a.userId), now, params.tz),
      lastAssignedAt: a.lastAssignedAt?.getTime() ?? 0,
      rating: fin >= 5 ? (delOf.get(a.userId) ?? 0) / fin : undefined,
    });
  }
  return out;
}

/** Merchant paused for billing (credit limit / overdue invoices, sections 19.2 and 19c.9). */
export function assignmentPaused(merchantSettings: unknown): boolean {
  const s = (merchantSettings ?? {}) as { billing?: { assignmentPaused?: boolean } };
  return s.billing?.assignmentPaused === true;
}

export interface AutoAssignResult {
  orderId: string;
  decision: AssignmentDecision | { ok: false; reason: "PAUSED" | "NOT_ASSIGNABLE" };
}

/**
 * Assign (or reassign) one order with the engine. `exclude` keeps the order away from given
 * agents (reassignment after 30 min, agent rotation, recycle).
 */
export async function autoAssignOrder(orderId: string, opts: { rule?: string; exclude?: string[]; podId?: string | null; now?: Date } = {}): Promise<AutoAssignResult> {
  return withSystemContext("auto-assign", async () => {
    const order = await prisma.order.findFirst({ where: { id: orderId } });
    if (!order || order.deletedAt) return { orderId, decision: { ok: false, reason: "NOT_ASSIGNABLE" } };
    const merchant = await prisma.organization.findUnique({ where: { id: order.merchantId }, select: { settings: true, timezone: true } });
    if (assignmentPaused(merchant?.settings)) return { orderId, decision: { ok: false, reason: "PAUSED" } };
    const ops = await loadOpsContext(prisma, order);
    const candidates = await buildCandidates(prisma, { merchantId: order.merchantId, podId: opts.podId, settings: ops.settings.assignment, tz: ops.timezone, now: opts.now });
    const decision = chooseAgent(candidates, { isHighValue: order.flags.includes("HIGH_VALUE"), wilayaCode: order.wilayaCode, exclude: opts.exclude }, ops.settings.assignment);
    if (!decision.ok) return { orderId, decision };
    const rule = opts.rule ?? decision.reason;
    const sys = systemContext(`assign:${rule}`);
    if (order.status === "EXPIREE" || order.status === "INJOIGNABLE") {
      await transitionOrder(sys, { orderId, to: "ASSIGNEE", payload: { assignedToId: decision.userId, podId: decision.podId, rule } });
    } else {
      await assignOrder(sys, { orderId, toUserId: decision.userId, rule });
    }
    await prisma.membership.updateMany({ where: { userId: decision.userId, podId: decision.podId ?? undefined }, data: { lastAssignedAt: new Date() } });
    return { orderId, decision };
  });
}

/** Release all open confirmation orders of an agent who went offline during the shift (section 9.2). */
export async function releaseAgentOrders(userId: string, merchantIds: string[]): Promise<number> {
  return withSystemContext("release-agent", async () => {
    const orders = await prisma.order.findMany({
      where: { assignedToId: userId, merchantId: { in: merchantIds }, status: { in: CONFIRMATION_OPEN_STATUSES }, deletedAt: null },
      select: { id: true, status: true },
    });
    let moved = 0;
    for (const o of orders) {
      const r = await autoAssignOrder(o.id, { rule: "AGENT_OFFLINE", exclude: [userId] });
      if (r.decision.ok) moved++;
    }
    return moved;
  });
}

/** Org settings for the team that owns a pod (used by the settings UI and jobs). */
export async function teamSettings(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true, timezone: true } });
  return { settings: parseOrgSettings(org?.settings), timezone: org?.timezone ?? "Africa/Algiers" };
}

export type { Prisma };
