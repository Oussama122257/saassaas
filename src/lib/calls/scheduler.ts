import type { Order, OrderStatus } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { autoAssignOrder, onShiftAt, shiftsByUser } from "@/lib/assign/rules";
import { loadOpsContext, releaseLock, transitionOrder, TransitionError } from "@/lib/orders/orderTransitions";
import { CLAIMABLE_STATUSES, CONFIRMATION_OPEN_STATUSES, EXPIRABLE_STATUSES } from "@/lib/orders/statuses";
import { systemContext } from "@/lib/tenant";
import { parseOrgSettings } from "@/lib/settings";
import { addDays, addHours, dateKeyInTz, startOfDayInTz } from "@/lib/time";
import { enqueue } from "@/lib/queue";

/**
 * System jobs of the confirmation engine (sections 8.2, 9.2, 19c.2). Each job is idempotent and
 * safe to run every minute; daily jobs are gated by JobRun keys in the org timezone.
 * All jobs run inside the system context (cross-tenant by design).
 */

const BATCH = 200;

export interface TickReport {
  [job: string]: number | string;
}

async function log(scope: string, n: number) {
  if (n > 0) console.log(`[scheduler] ${scope}: ${n}`);
}

async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TransitionError) return null;
    throw err;
  }
}

/** 1. New orders (and orphaned open orders) → assignment engine. */
export async function assignPendingOrders(now = new Date()): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, OR: [{ status: "NOUVEAU" }, { status: { in: CONFIRMATION_OPEN_STATUSES.filter((s) => s !== "EN_COURS_CONFIRMATION") }, assignedToId: null }] },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });
  let n = 0;
  for (const o of orders) {
    const r = await autoAssignOrder(o.id, { now });
    if (r.decision.ok) n++;
  }
  return n;
}

/** 2. NOUVEAU / ASSIGNEE untouched for 30 min → another available agent (rule UNTOUCHED_30M). */
export async function reassignUntouched(now = new Date()): Promise<number> {
  const candidates = await prisma.order.findMany({
    where: { deletedAt: null, status: "ASSIGNEE", attemptCount: 0, assignedToId: { not: null }, lockedById: null, lastActivityAt: { lt: addHours(now, -0.5) } },
    select: { id: true, merchantId: true, podId: true, assignedToId: true, lastActivityAt: true },
    take: BATCH,
  });
  let n = 0;
  for (const o of candidates) {
    const ops = await loadOpsContext(prisma, o);
    if (now.getTime() - o.lastActivityAt.getTime() < ops.settings.lifecycle.untouchedReassignMin * 60_000) continue;
    const r = await autoAssignOrder(o.id, { rule: "UNTOUCHED_30M", exclude: [o.assignedToId!], now });
    if (r.decision.ok) n++;
  }
  return n;
}

/** 3. Three failed attempts by the same agent in one day → the next day goes to another agent of the pod. */
export async function rotateAgents(now = new Date()): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, status: "APPEL_3", assignedToId: { not: null }, lockedById: null, nextActionAt: { lte: now }, attemptCount: { in: [3, 6] } },
    select: { id: true, assignedToId: true, podId: true, recycleRound: true },
    take: BATCH,
  });
  let n = 0;
  for (const o of orders) {
    const last3 = await prisma.callAttempt.findMany({ where: { orderId: o.id, round: o.recycleRound }, orderBy: { startedAt: "desc" }, take: 3, select: { agentId: true, outcome: true } });
    if (last3.length < 3 || last3.some((c) => c.agentId !== o.assignedToId || c.outcome === "ANSWERED")) continue;
    const r = await autoAssignOrder(o.id, { rule: "AGENT_ROTATION", exclude: [o.assignedToId!], podId: o.podId, now });
    if (r.decision.ok) n++;
  }
  return n;
}

async function requeueOne(o: Pick<Order, "id" | "merchantId" | "podId" | "assignedToId">, reason: string, now: Date): Promise<boolean> {
  const ops = await loadOpsContext(prisma, o);
  let keep = false;
  if (o.assignedToId) {
    const m = await prisma.membership.findFirst({ where: { userId: o.assignedToId, active: true }, select: { availability: true } });
    const shifts = await shiftsByUser(prisma, [o.assignedToId]);
    keep = m?.availability === "AVAILABLE" && onShiftAt(shifts.get(o.assignedToId), now, ops.timezone);
  }
  if (keep) {
    await prisma.orderEvent.create({ data: { orderId: o.id, type: "REQUEUE", payload: { reason, agentId: o.assignedToId } } });
    return true;
  }
  const r = await autoAssignOrder(o.id, { rule: reason, podId: o.podId, exclude: o.assignedToId ? [o.assignedToId] : [], now });
  if (r.decision.ok) await prisma.orderEvent.create({ data: { orderId: o.id, type: "REQUEUE", payload: { reason, agentId: r.decision.userId } } });
  return r.decision.ok;
}

/**
 * 4. Callback scheduler: REPORTE / CONFIRMEE_REPORTEE on their date → back to the queue (same agent
 * if on shift, else another agent of the pod). Callbacks due while the agent is off shift → reassign.
 */
export async function requeueDue(now = new Date()): Promise<number> {
  let n = 0;
  const postponed = await prisma.order.findMany({
    where: { deletedAt: null, status: { in: ["REPORTE", "CONFIRMEE_REPORTEE"] }, postponedUntil: { lte: now } },
    select: { id: true, merchantId: true, podId: true, assignedToId: true, status: true },
    take: BATCH,
  });
  for (const o of postponed) {
    // clear the marker first so the job never requeues twice
    await prisma.order.update({ where: { id: o.id, merchantId: o.merchantId }, data: { postponedUntil: null, nextActionAt: now } });
    if (await requeueOne(o, o.status === "REPORTE" ? "POSTPONED_DATE_REACHED" : "RECONFIRM_DATE_REACHED", now)) n++;
  }
  const callbacks = await prisma.order.findMany({
    where: { deletedAt: null, status: { in: CLAIMABLE_STATUSES }, flags: { has: "CALLBACK" }, nextActionAt: { lte: now }, lockedById: null },
    select: { id: true, merchantId: true, podId: true, assignedToId: true, flags: true },
    take: BATCH,
  });
  for (const o of callbacks) {
    await prisma.order.update({ where: { id: o.id, merchantId: o.merchantId }, data: { flags: o.flags.filter((f) => f !== "CALLBACK").concat("CALLBACK_DUE") } });
    if (await requeueOne(o, "CALLBACK_DUE", now)) n++;
  }
  return n;
}

/** 5. Claim/lock timeout: lock older than N minutes with no action → back to the previous status. */
export async function releaseExpiredLocks(now = new Date()): Promise<number> {
  const locked = await prisma.order.findMany({
    where: { status: "EN_COURS_CONFIRMATION", lockedAt: { lt: addHours(now, -1 / 60) } },
    select: { id: true, merchantId: true, podId: true, lockedAt: true },
    take: BATCH,
  });
  let n = 0;
  for (const o of locked) {
    const ops = await loadOpsContext(prisma, o);
    if (!o.lockedAt || now.getTime() - o.lockedAt.getTime() < ops.settings.lifecycle.lockTimeoutMin * 60_000) continue;
    const r = await safely(() => releaseLock(systemContext("lock-timeout"), o.id, "TIMEOUT"));
    if (r) n++;
  }
  return n;
}

/** 6. INJOIGNABLE after the 9th logged attempt (system only), or the cross-round cap. */
export async function markUnreachable(now = new Date()): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, status: "APPEL_3", lockedById: null, OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] },
    select: { id: true, merchantId: true, podId: true, attemptCount: true },
    take: BATCH,
  });
  let n = 0;
  for (const o of orders) {
    const ops = await loadOpsContext(prisma, o);
    const total = await prisma.callAttempt.count({ where: { orderId: o.id } });
    if (o.attemptCount < ops.settings.calls.maxAttemptsPerRound && total < ops.settings.calls.maxAttemptsTotal) continue;
    const r = await safely(() => transitionOrder(systemContext("unreachable"), { orderId: o.id, to: "INJOIGNABLE", payload: {} }));
    if (r) n++;
  }
  return n;
}

async function claimDaily(key: string, now: Date): Promise<boolean> {
  const existing = await prisma.jobRun.findUnique({ where: { key } });
  if (existing) return false;
  try {
    await prisma.jobRun.create({ data: { key, lastRunAt: now } });
    return true;
  } catch {
    return false; // another worker took it
  }
}

/** 7. Nightly expiry (00:00 org time): unconfirmed orders past the expiry window → EXPIREE. */
export async function nightlyExpiry(now = new Date(), opts: { force?: boolean } = {}): Promise<number> {
  const merchants = await prisma.organization.findMany({ where: { type: "MERCHANT", active: true }, select: { id: true, timezone: true } });
  let n = 0;
  for (const m of merchants) {
    if (!opts.force && !(await claimDaily(`expiry:${m.id}:${dateKeyInTz(now, m.timezone)}`, now))) continue;
    const orders = await prisma.order.findMany({
      where: { merchantId: m.id, deletedAt: null, status: { in: EXPIRABLE_STATUSES }, OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] },
      select: { id: true, merchantId: true, podId: true, lastAttemptAt: true, createdAt: true },
    });
    for (const o of orders) {
      const ops = await loadOpsContext(prisma, o);
      const reference = o.lastAttemptAt ?? o.createdAt;
      const cutoff = addDays(startOfDayInTz(now, ops.timezone), -ops.settings.lifecycle.expiryDays);
      if (reference >= cutoff) continue;
      const r = await safely(() => transitionOrder(systemContext("nightly-expiry"), { orderId: o.id, to: "EXPIREE", payload: { job: "nightly-expiry" } }));
      if (r) n++;
    }
  }
  return n;
}

/** 8. Recycle: EXPIREE / INJOIGNABLE not yet recycled, after the cool-down → a different agent, new round. */
export async function recycleOrders(now = new Date(), opts: { force?: boolean } = {}): Promise<number> {
  const merchants = await prisma.organization.findMany({ where: { type: "MERCHANT", active: true }, select: { id: true, timezone: true, settings: true } });
  let n = 0;
  for (const m of merchants) {
    if (!opts.force && !(await claimDaily(`recycle:${m.id}:${dateKeyInTz(now, m.timezone)}`, now))) continue;
    const orders = await prisma.order.findMany({
      where: { merchantId: m.id, deletedAt: null, status: { in: ["EXPIREE", "INJOIGNABLE"] } },
      select: { id: true, merchantId: true, podId: true, recycleRound: true, expiredAt: true, lastActivityAt: true },
    });
    for (const o of orders) {
      const ops = await loadOpsContext(prisma, o);
      if (o.recycleRound >= ops.settings.lifecycle.maxRecycleRounds) continue;
      const since = o.expiredAt ?? o.lastActivityAt;
      if (now.getTime() - since.getTime() < ops.settings.lifecycle.recycleCooldownDays * 86_400_000) continue;
      const previous = await prisma.callAttempt.findMany({ where: { orderId: o.id }, select: { agentId: true }, distinct: ["agentId"] });
      const r = await safely(() => autoAssignOrder(o.id, { rule: "RECYCLE", exclude: previous.map((p) => p.agentId), now }));
      if (r?.decision.ok) n++;
    }
  }
  return n;
}

/** 9. Outbound numbers: daily answer rate; burned after N days below the threshold (section 8.2). */
export async function updateNumberHealth(now = new Date(), opts: { force?: boolean; threshold?: number; days?: number } = {}): Promise<number> {
  const threshold = opts.threshold ?? 0.25;
  const days = opts.days ?? 3;
  if (!opts.force && !(await claimDaily(`numbers:${dateKeyInTz(now, "Africa/Algiers")}`, now))) return 0;
  const numbers = await prisma.outboundNumber.findMany({ where: { active: true, burnedAt: null, orgId: { not: "" } } });
  let burned = 0;
  for (const num of numbers) {
    const rates: number[] = [];
    for (let d = 1; d <= days; d++) {
      const from = startOfDayInTz(addDays(now, -d));
      const to = startOfDayInTz(addDays(now, -d + 1));
      const [total, answered] = await Promise.all([
        prisma.callAttempt.count({ where: { phoneNumberId: num.id, startedAt: { gte: from, lt: to }, orderId: { not: "" } } }),
        prisma.callAttempt.count({ where: { phoneNumberId: num.id, startedAt: { gte: from, lt: to }, outcome: "ANSWERED", orderId: { not: "" } } }),
      ]);
      if (total >= 10) rates.push(answered / total);
    }
    const latest = rates[0];
    const isBurned = rates.length === days && rates.every((r) => r < threshold);
    await prisma.outboundNumber.update({ where: { id: num.id, orgId: num.orgId }, data: { answerRate: latest ?? num.answerRate, ...(isBurned ? { burnedAt: now, active: false } : {}) } });
    if (isBurned) {
      burned++;
      await enqueue("notify.owner", { orgId: num.orgId, kind: "NUMBER_BURNED", message: `Outbound number ${num.label} (${num.msisdn}) answer rate stayed below ${Math.round(threshold * 100)}% for ${days} days and was retired.` });
    }
  }
  return burned;
}

/** Orders blocked in a status beyond the confirmation thresholds (STUCK_ALERT, phase 1 of the watchdog). */
export async function flagStaleConfirmation(now = new Date()): Promise<number> {
  const stale = await prisma.order.updateMany({
    where: { status: { in: ["NOUVEAU", "ASSIGNEE"] satisfies OrderStatus[] }, lastActivityAt: { lt: addHours(now, -2) }, NOT: { flags: { has: "STALE" } }, merchantId: { not: "" } },
    data: { flags: { push: "STALE" } },
  });
  return stale.count;
}

/** One scheduler tick (worker, every minute). */
export async function runConfirmationTick(now = new Date()): Promise<TickReport> {
  return withSystemContext("scheduler-tick", async () => {
    const report: TickReport = {};
    report.locks = await releaseExpiredLocks(now);
    report.assigned = await assignPendingOrders(now);
    report.untouched = await reassignUntouched(now);
    report.rotation = await rotateAgents(now);
    report.requeued = await requeueDue(now);
    report.unreachable = await markUnreachable(now);
    report.expired = await nightlyExpiry(now);
    report.recycled = await recycleOrders(now);
    report.numbersBurned = await updateNumberHealth(now);
    for (const [k, v] of Object.entries(report)) await log(k, Number(v));
    return report;
  });
}

export { parseOrgSettings };
