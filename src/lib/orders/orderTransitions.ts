import type { CallSlot, Order, OrderEvent, OrderStatus, Prisma, TaskType } from "@prisma/client";
import { prisma, withSystemContext, type DbClient } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import {
  AGENT_ROLES,
  ForbiddenError,
  NotFoundError,
  actorRole,
  isReadOnly,
  isSupervisorPlus,
  orderAccessWhere,
  requireRole,
  SUPERVISOR_PLUS,
  systemContext,
  type ActorContext,
  type TenantContext,
} from "@/lib/tenant";
import { writeAuditLog } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { resolveWilayaCode } from "@/lib/wilayas";
import { addDays, addHours, endOfDayInTz, zonedParts } from "@/lib/time";
import { statusGroupOf } from "./statuses";
import {
  attemptDayOf,
  findRules,
  nextAttemptStatus,
  overrideSchema,
  ruleAllowsActor,
  type Requirement,
  type SideEffect,
  type TransitionRule,
} from "./transitions";
import { dispatchSideEffects } from "./sideEffects";

/**
 * The ONLY place that changes Order.status. Everything goes through transitionOrder() or
 * overrideOrderStatus(); both write an immutable OrderEvent row.
 */

export type TransitionErrorCode =
  | "ORDER_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "FORBIDDEN_ACTOR"
  | "NOT_ORDER_OWNER"
  | "INVALID_PAYLOAD"
  | "PRECONDITION_FAILED";

export class TransitionError extends Error {
  constructor(
    public readonly code: TransitionErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionResult {
  order: Order;
  event: OrderEvent;
  ruleId: string;
}

export interface OrgSettings {
  minAnsweredCallSec: number;
  highValueThreshold: number;
  manualCallProof: boolean;
  mandatoryCancelNote: boolean;
  riskyWilayas: number[];
  maxOpenOrdersPerAgent: number;
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  minAnsweredCallSec: 15,
  highValueThreshold: 15000,
  manualCallProof: false,
  mandatoryCancelNote: false,
  riskyWilayas: [],
  maxOpenOrdersPerAgent: 40,
};

export function parseOrgSettings(raw: unknown): OrgSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<OrgSettings>;
  return { ...DEFAULT_ORG_SETTINGS, ...s };
}

function manualProofAllowed(settings: OrgSettings): boolean {
  return settings.manualCallProof || process.env.ALLOW_MANUAL_CALL_PROOF === "1";
}

function slotFor(date: Date, tz: string): CallSlot {
  const { hour } = zonedParts(date, tz);
  if (hour < 13) return "MORNING";
  if (hour < 17) return "AFTERNOON";
  return "EVENING";
}

function addFlag(flags: string[], flag: string): string[] {
  return flags.includes(flag) ? flags : [...flags, flag];
}

function removeFlag(flags: string[], flag: string): string[] {
  return flags.filter((f) => f !== flag);
}

/** Load an order the actor may act on. Agents only see their own orders (section 4.3). */
async function loadOrder(db: DbClient, ctx: ActorContext, orderId: string): Promise<Order> {
  const where: Prisma.OrderWhereInput = ctx.kind === "system" ? { id: orderId } : { AND: [{ id: orderId }, orderAccessWhere(ctx)] };
  const order = await db.order.findFirst({ where });
  if (!order) {
    // Distinguish "exists but not yours" from "does not exist" for agents without leaking data.
    if (ctx.kind === "user") {
      const exists = await db.order.findFirst({ where: { id: orderId, merchantId: { in: ctx.accessibleMerchantIds } }, select: { id: true } });
      if (exists) throw new TransitionError("NOT_ORDER_OWNER", "This order is not assigned to you");
    }
    throw new TransitionError("ORDER_NOT_FOUND", "Order not found");
  }
  return order;
}

async function loadMerchantSettings(db: DbClient, merchantId: string): Promise<{ settings: OrgSettings; timezone: string }> {
  const org = await db.organization.findUnique({ where: { id: merchantId }, select: { settings: true, timezone: true } });
  return { settings: parseOrgSettings(org?.settings), timezone: org?.timezone ?? "Africa/Algiers" };
}

async function checkRequirements(
  db: DbClient,
  rule: TransitionRule,
  order: Order,
  to: OrderStatus,
  payload: Record<string, unknown>,
  settings: OrgSettings,
): Promise<void> {
  for (const req of rule.requires as readonly Requirement[]) {
    switch (req.kind) {
      case "ANSWERED_CALL": {
        const min = req.minDurationSec ?? settings.minAnsweredCallSec;
        const n = await db.callAttempt.count({
          where: { orderId: order.id, outcome: "ANSWERED", OR: [{ durationSec: null }, { durationSec: { gte: min } }] },
        });
        if (n === 0) throw new TransitionError("PRECONDITION_FAILED", `Requires at least one answered call of ${min}s or more`, { requirement: req.kind });
        break;
      }
      case "ANY_LOGGED_CALL": {
        const n = await db.callAttempt.count({ where: { orderId: order.id } });
        if (n === 0) throw new TransitionError("PRECONDITION_FAILED", "Requires at least one logged call", { requirement: req.kind });
        break;
      }
      case "ATTEMPT_COUNT_EQUALS":
        if (order.attemptCount !== req.value) {
          throw new TransitionError("PRECONDITION_FAILED", `Requires exactly ${req.value} logged attempts (has ${order.attemptCount})`, { requirement: req.kind });
        }
        break;
      case "ATTEMPT_COUNT_LT":
        if (order.attemptCount >= req.value) {
          throw new TransitionError("PRECONDITION_FAILED", `Maximum of ${req.value} attempts reached`, { requirement: req.kind });
        }
        break;
      case "NEXT_ATTEMPT_STATUS": {
        const expected = nextAttemptStatus(order.attemptCount);
        if (to !== expected) {
          throw new TransitionError("PRECONDITION_FAILED", `Next attempt must be logged as ${expected}`, { requirement: req.kind, expected });
        }
        const call = payload.call as { proof?: string } | undefined;
        if (call?.proof === "NONE" && !manualProofAllowed(settings)) {
          throw new TransitionError("PRECONDITION_FAILED", "A call attempt without proof is rejected (manual mode is disabled)", { requirement: "CALL_PROOF" });
        }
        break;
      }
      case "STOCK_ZERO": {
        const items = await db.orderItem.findMany({ where: { orderId: order.id }, select: { productId: true, variantId: true } });
        const stock = await db.stockItem.findMany({
          where: { OR: items.map((i) => ({ productId: i.productId, variantId: i.variantId ?? null })) },
          select: { onHand: true, reserved: true },
        });
        const available = stock.reduce((acc, s) => acc + (s.onHand - s.reserved), 0);
        if (available > 0) throw new TransitionError("PRECONDITION_FAILED", "Stock is available; confirm normally", { requirement: req.kind, available });
        break;
      }
      case "NOT_FLAGGED":
        if (order.flags.includes(req.flag)) {
          throw new TransitionError("PRECONDITION_FAILED", `Order is flagged ${req.flag}`, { requirement: req.kind, flag: req.flag });
        }
        break;
      case "NOTE_IF_OTHER": {
        const reason = (payload.cancelReason ?? payload.returnReason) as string | undefined;
        const note = (payload.reasonNote as string | undefined)?.trim();
        if ((reason === "OTHER" || settings.mandatoryCancelNote) && !note) {
          throw new TransitionError("INVALID_PAYLOAD", "A written note is required for this reason", { requirement: req.kind });
        }
        break;
      }
      case "POSTPONE_MAX_DAYS": {
        const until = payload.postponedUntil as Date;
        const max = addDays(new Date(), req.days);
        if (until.getTime() > max.getTime() + 60_000) {
          throw new TransitionError("INVALID_PAYLOAD", `Postponement cannot exceed ${req.days} days`, { requirement: req.kind });
        }
        if (until.getTime() < Date.now() - 60_000) {
          throw new TransitionError("INVALID_PAYLOAD", "Postponement date must be in the future", { requirement: req.kind });
        }
        break;
      }
    }
  }
}

const DELIVERY_TASK_MAP: Partial<Record<OrderStatus, TaskType>> = {
  CLIENT_INJOIGNABLE_LIVREUR: "RESCUE_NO_ANSWER",
  REPORTE_CLIENT: "RESCHEDULE_CALL",
  ADRESSE_ERRONEE: "WRONG_ADDRESS",
  TENTATIVE_ECHOUEE: "FAILED_ATTEMPT_CALL",
  REFUSE: "PRE_RETURN_CALL",
  ALERTE: "ALERT",
  STOP_DESK: "STOPDESK_REMINDER",
};

async function followUpUserFor(db: DbClient, order: Order): Promise<string | null> {
  if (!order.podId) return null;
  const pod = await db.pod.findUnique({ where: { id: order.podId }, select: { followUpUserId: true } });
  return pod?.followUpUserId ?? null;
}

interface ApplyResult {
  data: Prisma.OrderUpdateInput;
  eventPayload: Record<string, unknown>;
}

/** Rule-specific writes. Keeps every status-specific field change in one place. */
async function applyRule(
  db: DbClient,
  rule: TransitionRule,
  ctx: ActorContext,
  order: Order,
  to: OrderStatus,
  payload: Record<string, unknown>,
  settings: OrgSettings,
  tz: string,
): Promise<ApplyResult> {
  const now = new Date();
  const actorId = ctx.kind === "user" ? ctx.userId : null;
  let flags = [...order.flags];
  const data: Prisma.OrderUpdateInput = {};
  const eventPayload: Record<string, unknown> = { ...payload };

  switch (rule.id) {
    case "ASSIGN": {
      const p = payload as { assignedToId: string; podId?: string | null; rule?: string };
      data.assignedTo = { connect: { id: p.assignedToId } };
      if (p.podId) data.pod = { connect: { id: p.podId } };
      data.nextActionAt = now;
      break;
    }
    case "DUPLICATE_DETECTED": {
      const p = payload as { duplicateOfId: string };
      data.duplicateOf = { connect: { id: p.duplicateOfId } };
      flags = addFlag(flags, "DUPLICATE_SUSPECT");
      break;
    }
    case "LOG_CALL": {
      const p = payload as {
        call: { outcome: string; proof: string; startedAt?: Date; durationSec?: number; phoneNumberId?: string; recordingUrl?: string; callbackAt?: Date; note?: string; agentId?: string };
      };
      const startedAt = p.call.startedAt ?? now;
      const attemptNo = order.attemptCount + 1;
      const agentId = p.call.agentId ?? actorId ?? order.assignedToId;
      if (!agentId) throw new TransitionError("INVALID_PAYLOAD", "call.agentId is required when the system logs a call");
      const call = await db.callAttempt.create({
        data: {
          orderId: order.id,
          agentId,
          phoneNumberId: p.call.phoneNumberId,
          attemptNo,
          day: attemptDayOf(attemptNo),
          slot: slotFor(startedAt, tz),
          startedAt,
          durationSec: p.call.durationSec,
          outcome: p.call.outcome as never,
          proof: p.call.proof as never,
          recordingUrl: p.call.recordingUrl,
          note: p.call.note,
        },
      });
      data.attemptCount = attemptNo;
      data.attemptDay = attemptDayOf(attemptNo);
      if (p.call.proof === "NONE") flags = addFlag(flags, "MANUAL_PROOF");
      if (p.call.outcome === "CALLBACK_REQUESTED" && p.call.callbackAt) data.nextActionAt = p.call.callbackAt;
      else if (p.call.outcome !== "ANSWERED") data.nextActionAt = addHours(startedAt, 2);
      else data.nextActionAt = null;
      eventPayload.callAttemptId = call.id;
      eventPayload.attemptNo = attemptNo;
      break;
    }
    case "CONFIRM":
    case "STOCK_BACK": {
      const p = payload as { note?: string };
      if (rule.id === "CONFIRM" && actorId) data.confirmedBy = { connect: { id: actorId } };
      data.confirmedAt = order.confirmedAt ?? now;
      data.nextActionAt = null;
      data.postponedUntil = null;
      if (p.note) data.note = p.note;
      flags = removeFlag(flags, "WAITING_STOCK");
      const followUp = await followUpUserFor(db, order);
      if (followUp) {
        data.assignedTo = { connect: { id: followUp } };
        eventPayload.handedOffTo = followUp;
      }
      break;
    }
    case "CONFIRM_OUT_OF_STOCK": {
      if (actorId) data.confirmedBy = { connect: { id: actorId } };
      data.confirmedAt = now;
      data.nextActionAt = null;
      flags = addFlag(flags, "WAITING_STOCK");
      const task = await db.task.create({ data: { orderId: order.id, type: "WAITING_STOCK", dueAt: addHours(now, 48) } });
      eventPayload.taskId = task.id;
      break;
    }
    case "CONFIRM_BOT": {
      data.confirmedAt = now;
      data.nextActionAt = null;
      flags = addFlag(flags, "BOT_CONFIRMED");
      const risky = flags.includes("HIGH_VALUE") || settings.riskyWilayas.includes(order.wilayaCode);
      if (risky) {
        flags = addFlag(flags, "NEEDS_VERIFICATION");
        const task = await db.task.create({
          data: { orderId: order.id, type: "VERIFY_BOT_CONFIRMATION", assigneeId: order.assignedToId, dueAt: endOfDayInTz(now, tz) },
        });
        eventPayload.taskId = task.id;
        eventPayload.verificationRequired = true;
      } else {
        const followUp = await followUpUserFor(db, order);
        if (followUp) data.assignedTo = { connect: { id: followUp } };
      }
      break;
    }
    case "CANCEL": {
      const p = payload as { cancelReason: string; reasonNote?: string };
      data.cancelReason = p.cancelReason as never;
      data.reasonNote = p.reasonNote ?? null;
      data.nextActionAt = null;
      break;
    }
    case "POSTPONE": {
      const p = payload as { postponedUntil: Date; reason: string };
      data.postponedUntil = p.postponedUntil;
      data.nextActionAt = p.postponedUntil;
      data.reasonNote = p.reason;
      break;
    }
    case "TO_VERIFY": {
      const p = payload as { comment: string };
      data.reasonNote = p.comment;
      data.nextActionAt = null;
      const task = await db.task.create({ data: { orderId: order.id, type: "VERIFY_ORDER", dueAt: addHours(now, 24) } });
      eventPayload.taskId = task.id;
      break;
    }
    case "DUPLICATE_MERGE": {
      const p = payload as { verificationNote: string };
      data.cancelReason = "OTHER";
      data.reasonNote = `Duplicate — ${p.verificationNote}`;
      flags = addFlag(flags, "MERGED_DUPLICATE");
      break;
    }
    case "DUPLICATE_REOPEN": {
      data.duplicateOf = { disconnect: true };
      flags = removeFlag(flags, "DUPLICATE_SUSPECT");
      if (ctx.kind === "user" && AGENT_ROLES.includes(ctx.role)) data.assignedTo = { connect: { id: ctx.userId } };
      data.nextActionAt = now;
      break;
    }
    case "FAKE_ORDER": {
      const p = payload as { note?: string; blacklistRequest?: boolean };
      if (p.note) data.reasonNote = p.note;
      flags = removeFlag(flags, "FAKE_PROPOSED");
      if (p.blacklistRequest) flags = addFlag(flags, "BLACKLIST_REQUESTED");
      data.nextActionAt = null;
      break;
    }
    case "UNREACHABLE":
      data.nextActionAt = null;
      break;
    case "READY_TO_SHIP":
      break;
    case "SHIPPED": {
      const p = payload as { trackingNumber: string; courierId?: string; labelUrl?: string };
      data.trackingNumber = p.trackingNumber;
      if (p.courierId) data.courier = { connect: { id: p.courierId } };
      if (p.labelUrl) data.labelUrl = p.labelUrl;
      data.shippedAt = now;
      data.lastSendFailure = null;
      break;
    }
    case "COURIER_SYNC": {
      data.lastCourierSyncAt = now;
      const taskType = DELIVERY_TASK_MAP[to];
      if (taskType) {
        const followUp = await followUpUserFor(db, order);
        const dueAt = to === "STOP_DESK" ? addDays(now, 2) : endOfDayInTz(now, tz);
        const task = await db.task.create({ data: { orderId: order.id, type: taskType, assigneeId: followUp, dueAt } });
        eventPayload.taskId = task.id;
        eventPayload.taskType = taskType;
      }
      if (to === "REFUSE") {
        const customer = await db.customer.update({
          where: { id: order.customerId, merchantId: order.merchantId },
          data: { refusedCount: { increment: 1 } },
          select: { refusedCount: true },
        });
        if (customer.refusedCount >= 2) flags = addFlag(flags, "REPEAT_REFUSER");
      }
      break;
    }
    case "DELIVERED": {
      const p = payload as { deliveredAt?: Date };
      data.deliveredAt = p.deliveredAt ?? now;
      data.lastCourierSyncAt = now;
      await db.customer.update({ where: { id: order.customerId, merchantId: order.merchantId }, data: { deliveredCount: { increment: 1 } } });
      break;
    }
    case "RETURN_STARTED": {
      const p = payload as { returnReason: string; reasonNote?: string };
      data.returnReason = p.returnReason as never;
      if (p.reasonNote) data.reasonNote = p.reasonNote;
      eventPayload.confirmedById = order.confirmedById;
      break;
    }
    case "RETURN_RECEIVED": {
      const p = payload as { condition: string; note?: string };
      data.returnedAt = now;
      eventPayload.condition = p.condition;
      break;
    }
    case "LOST_OR_DAMAGED": {
      const p = payload as { note: string };
      data.reasonNote = p.note;
      break;
    }
    case "CASH_COLLECTED":
      data.cashCollectedAt = now;
      break;
  }

  if (flags.join("|") !== order.flags.join("|")) data.flags = flags;
  return { data, eventPayload };
}

function sanitizeForJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

/**
 * Move an order to a new status through the transition table.
 * Throws TransitionError with a stable `code` the UI/API translate.
 */
export async function transitionOrder(
  ctx: ActorContext,
  input: { orderId: string; to: OrderStatus; payload?: unknown },
): Promise<TransitionResult> {
  if (isReadOnly(ctx)) throw new ForbiddenError("Read-only role");
  const role = actorRole(ctx);

  const run = () => prisma.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, input.orderId);
    const candidates = findRules(order.status, input.to);
    if (candidates.length === 0) {
      throw new TransitionError("ILLEGAL_TRANSITION", `No transition from ${order.status} to ${input.to}`, { from: order.status, to: input.to });
    }
    const rule = candidates.find((r) => ruleAllowsActor(r, role));
    if (!rule) {
      const allowed = [...new Set(candidates.flatMap((r) => r.actors))];
      throw new TransitionError("FORBIDDEN_ACTOR", `${role} may not set ${input.to} (allowed: ${allowed.join(", ")})`, { allowed });
    }
    const parsed = rule.schema.safeParse(input.payload ?? {});
    if (!parsed.success) {
      throw new TransitionError("INVALID_PAYLOAD", "Missing or invalid fields for this transition", parsed.error.issues);
    }
    const payload = parsed.data as Record<string, unknown>;
    const { settings, timezone } = await loadMerchantSettings(tx, order.merchantId);
    await checkRequirements(tx, rule, order, input.to, payload, settings);
    const { data, eventPayload } = await applyRule(tx, rule, ctx, order, input.to, payload, settings, timezone);

    const updated = await tx.order.update({
      where: { id: order.id, merchantId: order.merchantId },
      data: { ...data, status: input.to, statusGroup: statusGroupOf(input.to), lastActivityAt: new Date() },
    });
    const event = await tx.orderEvent.create({
      data: {
        orderId: order.id,
        actorId: ctx.kind === "user" ? ctx.userId : null,
        type: "STATUS_CHANGE",
        fromStatus: order.status,
        toStatus: input.to,
        payload: sanitizeForJson({ ruleId: rule.id, actor: role, ...eventPayload }),
      },
    });
    return { order: updated, event, ruleId: rule.id, sideEffects: rule.sideEffects, payload };
  });
  const result = ctx.kind === "system" ? await withSystemContext(ctx.reason, run) : await run();

  await dispatchSideEffects({ ctx, order: result.order, event: result.event, sideEffects: result.sideEffects as readonly SideEffect[], payload: result.payload });
  return { order: result.order, event: result.event, ruleId: result.ruleId };
}

/**
 * Supervisor override outside the transition table. Requires a reason, writes an OVERRIDE event,
 * flags the order and records an org-level audit entry.
 */
export async function overrideOrderStatus(
  ctx: ActorContext,
  input: { orderId: string; to: OrderStatus; reason: string },
): Promise<TransitionResult> {
  requireRole(ctx, SUPERVISOR_PLUS);
  const parsed = overrideSchema.safeParse({ reason: input.reason });
  if (!parsed.success) throw new TransitionError("INVALID_PAYLOAD", "Override requires a reason (5+ characters)", parsed.error.issues);
  if (input.to === "INJOIGNABLE" && ctx.kind === "user") {
    // Rule 4: humans never set INJOIGNABLE, not even by override.
    throw new TransitionError("FORBIDDEN_ACTOR", "INJOIGNABLE is set by the scheduler only");
  }

  const run = () => prisma.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, input.orderId);
    if (order.status === input.to) throw new TransitionError("ILLEGAL_TRANSITION", "Order is already in this status");
    const updated = await tx.order.update({
      where: { id: order.id, merchantId: order.merchantId },
      data: {
        status: input.to,
        statusGroup: statusGroupOf(input.to),
        flags: addFlag(order.flags, "OVERRIDDEN"),
        lastActivityAt: new Date(),
        ...(input.to === "LIVRE" ? { deliveredAt: order.deliveredAt ?? new Date() } : {}),
        ...(input.to === "EXPEDIE" ? { shippedAt: order.shippedAt ?? new Date() } : {}),
      },
    });
    const event = await tx.orderEvent.create({
      data: {
        orderId: order.id,
        actorId: ctx.kind === "user" ? ctx.userId : null,
        type: "OVERRIDE",
        fromStatus: order.status,
        toStatus: input.to,
        payload: { reason: parsed.data.reason, flagged: true, actor: actorRole(ctx) },
      },
    });
    await writeAuditLog(
      ctx,
      { action: "ORDER_OVERRIDE", targetType: "Order", targetId: order.id, payload: { from: order.status, to: input.to, reason: parsed.data.reason } },
      tx,
    );
    return { order: updated, event };
  });
  const result = ctx.kind === "system" ? await withSystemContext(ctx.reason, run) : await run();

  await dispatchSideEffects({ ctx, order: result.order, event: result.event, sideEffects: [], payload: { override: true, reason: parsed.data.reason } });
  return { ...result, ruleId: "OVERRIDE" };
}

// ─────────────────────────────── assignment ───────────────────────────────

/**
 * Give an order to an agent. NOUVEAU orders go through the ASSIGN transition; otherwise the owner
 * changes in place with an ASSIGN/REASSIGN event (section 9.2: every reassignment is logged with
 * old agent, new agent and rule id so per-agent KPIs stay fair).
 */
export async function assignOrder(
  ctx: ActorContext,
  input: { orderId: string; toUserId: string; rule?: string },
): Promise<{ order: Order; event: OrderEvent }> {
  if (ctx.kind === "user" && !isSupervisorPlus(ctx)) throw new ForbiddenError("Only supervisors can (re)assign orders");
  const rule = input.rule ?? (ctx.kind === "system" ? "SYSTEM" : "MANUAL");

  const run = async () => {
    const current = await loadOrder(prisma, ctx, input.orderId);
    const membership = await prisma.membership.findFirst({
      where: {
        userId: input.toUserId,
        active: true,
        role: { in: ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR"] },
        ...(ctx.kind === "user" ? { orgId: ctx.orgId } : {}),
      },
      select: { podId: true, orgId: true },
    });
    if (!membership) throw new NotFoundError("Target agent not found in this organization");

    if (current.status === "NOUVEAU") {
      // First assignment goes through the state machine so the ASSIGN rule (and its event) applies.
      const t = await transitionOrder(ctx, {
        orderId: input.orderId,
        to: "ASSIGNEE",
        payload: { assignedToId: input.toUserId, podId: membership.podId, rule },
      });
      return { order: t.order, event: t.event, fromUserId: null as string | null };
    }

    return prisma.$transaction(async (tx) => {
      const order = await loadOrder(tx, ctx, input.orderId);
      const updated = await tx.order.update({
        where: { id: order.id, merchantId: order.merchantId },
        data: {
          assignedTo: { connect: { id: input.toUserId } },
          ...(membership.podId ? { pod: { connect: { id: membership.podId } } } : {}),
          lastActivityAt: new Date(),
        },
      });
      const event = await tx.orderEvent.create({
        data: {
          orderId: order.id,
          actorId: ctx.kind === "user" ? ctx.userId : null,
          type: order.assignedToId ? "REASSIGN" : "ASSIGN",
          payload: { fromUserId: order.assignedToId, toUserId: input.toUserId, rule },
        },
      });
      return { order: updated, event, fromUserId: order.assignedToId };
    });
  };
  const result = ctx.kind === "system" ? await withSystemContext(ctx.reason, run) : await run();

  await enqueue("order.assigned", {
    orderId: result.order.id,
    merchantId: result.order.merchantId,
    fromUserId: result.fromUserId,
    toUserId: input.toUserId,
    rule,
  });
  return { order: result.order, event: result.event };
}

/** Free-text note on an order (visible in the timeline). */
export async function addOrderNote(ctx: TenantContext, input: { orderId: string; note: string }): Promise<OrderEvent> {
  if (isReadOnly(ctx)) throw new ForbiddenError("Read-only role");
  const note = input.note.trim();
  if (note.length < 1) throw new TransitionError("INVALID_PAYLOAD", "Note cannot be empty");
  return prisma.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, input.orderId);
    await tx.order.update({ where: { id: order.id, merchantId: order.merchantId }, data: { lastActivityAt: new Date() } });
    return tx.orderEvent.create({ data: { orderId: order.id, actorId: ctx.userId, type: "NOTE", payload: { note } } });
  });
}

/** Agent proposes FAUSSE_COMMANDE; the supervisor finalizes through the FAKE_ORDER transition. */
export async function proposeFakeOrder(ctx: TenantContext, input: { orderId: string; note: string }): Promise<OrderEvent> {
  if (isReadOnly(ctx)) throw new ForbiddenError("Read-only role");
  return prisma.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, input.orderId);
    const calls = await tx.callAttempt.count({ where: { orderId: order.id } });
    if (calls === 0) throw new TransitionError("PRECONDITION_FAILED", "Log a call before proposing a fake order");
    await tx.order.update({
      where: { id: order.id, merchantId: order.merchantId },
      data: { flags: addFlag(order.flags, "FAKE_PROPOSED"), lastActivityAt: new Date() },
    });
    await tx.task.create({ data: { orderId: order.id, type: "VERIFY_ORDER", dueAt: addHours(new Date(), 24) } });
    return tx.orderEvent.create({ data: { orderId: order.id, actorId: ctx.userId, type: "NOTE", payload: { note: input.note, proposal: "FAUSSE_COMMANDE" } } });
  });
}

// ─────────────────────────────── creation ───────────────────────────────

export interface CreateOrderInput {
  merchantId: string;
  storeId: string;
  externalId?: string | null;
  customer: { name?: string | null; phone: string; phone2?: string | null };
  wilaya: number | string;
  commune?: string | null;
  address?: string | null;
  landmark?: string | null;
  deliveryType?: "HOME" | "STOP_DESK";
  items: Array<{ productId: string; variantId?: string | null; qty: number; unitPrice?: number }>;
  shippingFee?: number;
  source?: string | null;
  note?: string | null;
  flags?: string[];
  /** seed/backfill only */
  createdAt?: Date;
  /** skip duplicate detection (seed/backfill) */
  skipDuplicateCheck?: boolean;
}

export class OrderValidationError extends Error {
  readonly code = "INVALID_ORDER";
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "OrderValidationError";
  }
}

/**
 * Create an order in NOUVEAU (section 7.3 first row): phone normalization, wilaya mapping,
 * customer upsert, sequence number, duplicate detection, HIGH_VALUE flag, audit event.
 * Ingestion adapters (Shopify, DZBuild, API, manual form) all end here.
 */
export async function createOrder(ctx: ActorContext, input: CreateOrderInput): Promise<Order> {
  if (ctx.kind === "user") {
    if (isReadOnly(ctx)) throw new ForbiddenError("Read-only role");
    if (!ctx.accessibleMerchantIds.includes(input.merchantId)) throw new ForbiddenError("No access to this merchant");
  }
  if (input.items.length === 0) throw new OrderValidationError("An order needs at least one item");

  const phone = normalizePhone(input.customer.phone);
  const phone2 = input.customer.phone2 ? normalizePhone(input.customer.phone2) : null;
  const wilayaCode = resolveWilayaCode(input.wilaya);
  const flags = new Set(input.flags ?? []);
  const problems: string[] = [];
  if (!phone.valid) {
    flags.add("INVALID_PHONE");
    problems.push("invalid phone");
  }
  if (!wilayaCode) {
    flags.add("UNKNOWN_WILAYA");
    problems.push(`unknown wilaya "${String(input.wilaya)}"`);
  }
  const customerPhone = phone.phone ?? input.customer.phone.replace(/\D/g, "").slice(0, 20);
  if (!customerPhone) throw new OrderValidationError("A phone number is required");

  const createTx = () => prisma.$transaction(async (tx) => {
    const store = await tx.store.findFirst({ where: { id: input.storeId, merchantId: input.merchantId }, select: { id: true } });
    if (!store) throw new OrderValidationError("Store not found for this merchant");

    const products = await tx.product.findMany({
      where: { merchantId: input.merchantId, id: { in: input.items.map((i) => i.productId) } },
      select: { id: true, price: true },
    });
    const priceOf = new Map(products.map((p) => [p.id, p.price]));
    const items = input.items.map((i) => {
      const base = priceOf.get(i.productId);
      if (base === undefined) throw new OrderValidationError(`Product ${i.productId} not found for this merchant`);
      return { productId: i.productId, variantId: i.variantId ?? null, qty: i.qty, unitPrice: i.unitPrice ?? base };
    });
    const subtotal = items.reduce((acc, i) => acc + i.qty * i.unitPrice, 0);
    const shippingFee = input.shippingFee ?? 0;
    const total = subtotal + shippingFee;

    const org = await tx.organization.update({
      where: { id: input.merchantId },
      data: { orderSeq: { increment: 1 } },
      select: { orderSeq: true, settings: true },
    });
    const settings = parseOrgSettings(org.settings);
    if (total >= settings.highValueThreshold) flags.add("HIGH_VALUE");

    const customer = await tx.customer.upsert({
      where: { merchantId_phone: { merchantId: input.merchantId, phone: customerPhone } },
      create: {
        merchantId: input.merchantId,
        phone: customerPhone,
        phone2: phone2?.phone ?? null,
        name: input.customer.name ?? null,
        ordersCount: 1,
      },
      update: {
        ordersCount: { increment: 1 },
        ...(input.customer.name ? { name: input.customer.name } : {}),
        ...(phone2?.phone ? { phone2: phone2.phone } : {}),
      },
    });
    if (customer.blacklisted) flags.add("BLACKLISTED_CUSTOMER");
    if (customer.refusedCount >= 2) flags.add("REPEAT_REFUSER");

    const initialStatus: OrderStatus = problems.length > 0 ? "A_VERIFIER" : "NOUVEAU";

    const order = await tx.order.create({
      data: {
        merchantId: input.merchantId,
        storeId: store.id,
        seq: org.orderSeq,
        externalId: input.externalId ?? null,
        customerId: customer.id,
        customerName: input.customer.name ?? customer.name,
        customerPhone,
        customerPhone2: phone2?.phone ?? null,
        status: initialStatus,
        statusGroup: "CONFIRMATION",
        wilayaCode: wilayaCode ?? 16,
        commune: input.commune ?? null,
        address: input.address ?? null,
        landmark: input.landmark ?? null,
        deliveryType: input.deliveryType ?? "HOME",
        subtotal,
        shippingFee,
        total,
        source: input.source ?? null,
        note: input.note ?? null,
        reasonNote: problems.length > 0 ? `Intake check failed: ${problems.join(", ")}` : null,
        flags: [...flags],
        createdAt: input.createdAt,
        lastActivityAt: input.createdAt ?? new Date(),
        items: { create: items },
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        actorId: ctx.kind === "user" ? ctx.userId : null,
        type: "STATUS_CHANGE",
        fromStatus: null,
        toStatus: initialStatus,
        payload: { ruleId: "CREATE", source: input.source ?? null, externalId: input.externalId ?? null, problems },
        createdAt: input.createdAt,
      },
    });
    if (problems.length > 0) {
      await tx.task.create({ data: { orderId: order.id, type: "VERIFY_ORDER", dueAt: addHours(new Date(), 24) } });
    }

    // Duplicate detection: same customer + same product within 48 h, previous order still alive.
    let duplicateOfId: string | null = null;
    if (!input.skipDuplicateCheck && initialStatus === "NOUVEAU") {
      const since = addDays(order.createdAt, -2);
      const previous = await tx.order.findFirst({
        where: {
          merchantId: input.merchantId,
          customerId: customer.id,
          id: { not: order.id },
          createdAt: { gte: since },
          status: { notIn: ["ANNULEE", "DOUBLE", "FAUSSE_COMMANDE", "INJOIGNABLE"] },
          items: { some: { productId: { in: items.map((i) => i.productId) } } },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      duplicateOfId = previous?.id ?? null;
    }
    return { order, duplicateOfId };
  });
  const created = ctx.kind === "system" ? await withSystemContext(ctx.reason, createTx) : await createTx();

  if (created.duplicateOfId) {
    const t = await transitionOrder(systemContext("duplicate-detection"), {
      orderId: created.order.id,
      to: "DOUBLE",
      payload: { duplicateOfId: created.duplicateOfId },
    });
    return t.order;
  }

  await enqueue("order.status_changed", {
    orderId: created.order.id,
    merchantId: created.order.merchantId,
    from: null,
    to: created.order.status,
    actorId: ctx.kind === "user" ? ctx.userId : null,
    sideEffects: [],
    payload: { ruleId: "CREATE" },
  });
  return created.order;
}
