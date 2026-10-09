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
import { addDays, addHours, endOfDayInTz } from "@/lib/time";
import { parseOrgSettings, type OrgSettings } from "@/lib/settings";
import { checkAttempt, hasEnoughSpacedAttempts, planAttempt, slotOf, type AttemptRejection } from "@/lib/calls/slots";
import { detectFakeSignals, validateAddress, type CommuneRef, type MappingError } from "@/lib/intake/validate";
import { CLEAR_FAKE_REASONS, statusGroupOf } from "./statuses";
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

export { DEFAULT_ORG_SETTINGS, parseOrgSettings, type OrgSettings } from "@/lib/settings";

/**
 * The ONLY place that changes Order.status. Everything goes through transitionOrder() or
 * overrideOrderStatus(); both write an immutable OrderEvent row.
 */

export type TransitionErrorCode =
  | "ORDER_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "FORBIDDEN_ACTOR"
  | "NOT_ORDER_OWNER"
  | "ORDER_LOCKED"
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

/** Settings + timezone + team org for an order (see src/lib/settings.ts for the resolution order). */
export interface OpsContext {
  settings: OrgSettings;
  timezone: string;
  /** org that owns the pod working the order (agency, or the merchant itself with its own team) */
  teamOrgId: string | null;
}

export async function loadOpsContext(db: DbClient, order: Pick<Order, "merchantId" | "podId">): Promise<OpsContext> {
  const merchant = await db.organization.findUnique({ where: { id: order.merchantId }, select: { settings: true, timezone: true } });
  let teamOrgId: string | null = null;
  if (order.podId) {
    const pod = await db.pod.findUnique({ where: { id: order.podId }, select: { orgId: true } });
    teamOrgId = pod?.orgId ?? null;
  }
  if (!teamOrgId) {
    const contract = await db.serviceContract.findFirst({
      where: { merchantId: order.merchantId, status: { in: ["TRIAL", "ACTIVE"] } },
      select: { agencyId: true },
      orderBy: { startsAt: "asc" },
    });
    teamOrgId = contract?.agencyId ?? order.merchantId;
  }
  let teamSettings: unknown = {};
  if (teamOrgId !== order.merchantId) {
    const team = await db.organization.findUnique({ where: { id: teamOrgId }, select: { settings: true } });
    teamSettings = team?.settings ?? {};
  }
  return { settings: parseOrgSettings(merchant?.settings, teamSettings), timezone: merchant?.timezone ?? "Africa/Algiers", teamOrgId };
}

function manualProofAllowed(settings: OrgSettings): boolean {
  return settings.manualCallProof || process.env.ALLOW_MANUAL_CALL_PROOF === "1";
}

function slotFor(date: Date, tz: string): CallSlot {
  return slotOf(date, tz);
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

/** True when the order is claimed by someone else and the claim has not timed out. */
export function lockedByOther(order: Pick<Order, "lockedById" | "lockedAt">, userId: string | null, lockTimeoutMin: number, now = new Date()): boolean {
  if (!order.lockedById || !order.lockedAt) return false;
  if (order.lockedById === userId) return false;
  return now.getTime() - order.lockedAt.getTime() < lockTimeoutMin * 60_000;
}

const ATTEMPT_REJECTION_MESSAGES: Record<AttemptRejection, string> = {
  FUTURE_ATTEMPT: "The attempt time is in the future",
  BLOCKED_WINDOW: "Calls are not allowed at this time (before 09:00, after 21:00, prayer time or Friday midday)",
  MIN_GAP: "Too soon after the previous attempt (minimum spacing between two attempts)",
  OUTSIDE_SLOT: "This attempt must be made inside its slot window",
  SAME_CALENDAR_DAY: "The first attempt of a new day must be on a later day than the previous attempt",
  MAX_ATTEMPTS: "Maximum number of attempts reached",
};

async function roundAttemptDates(db: DbClient, order: Order): Promise<Date[]> {
  const calls = await db.callAttempt.findMany({ where: { orderId: order.id, round: order.recycleRound }, select: { startedAt: true }, orderBy: { startedAt: "asc" } });
  return calls.map((c) => c.startedAt);
}

async function checkRequirements(
  db: DbClient,
  rule: TransitionRule,
  ctx: ActorContext,
  order: Order,
  to: OrderStatus,
  payload: Record<string, unknown>,
  ops: OpsContext,
): Promise<void> {
  const { settings, timezone: tz } = ops;
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
        if (order.attemptCount >= Math.min(req.value, settings.calls.maxAttemptsPerRound)) {
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
      case "CALL_TIMING": {
        const call = payload.call as { startedAt?: Date } | undefined;
        const startedAt = call?.startedAt ?? new Date();
        const previous = await roundAttemptDates(db, order);
        const totalAttempts = await db.callAttempt.count({ where: { orderId: order.id } });
        const rejection = checkAttempt({ attemptNo: order.attemptCount + 1, startedAt, previous, totalAttempts, cfg: settings.calls, tz });
        if (rejection) {
          throw new TransitionError("PRECONDITION_FAILED", ATTEMPT_REJECTION_MESSAGES[rejection], { requirement: req.kind, rejection });
        }
        break;
      }
      case "SPACED_ATTEMPTS": {
        const fakeReason = payload.fakeReason as string | undefined;
        if (req.exemptClearFake && fakeReason && (CLEAR_FAKE_REASONS as readonly string[]).includes(fakeReason)) {
          const calls = await db.callAttempt.count({ where: { orderId: order.id } });
          if (calls === 0 && !order.flags.includes("INVALID_PHONE") && fakeReason === "INVALID_PHONE" && normalizePhone(order.customerPhone).valid) {
            throw new TransitionError("PRECONDITION_FAILED", "Log at least one call before declaring the number invalid", { requirement: req.kind });
          }
          break;
        }
        const calls = await db.callAttempt.findMany({ where: { orderId: order.id }, select: { startedAt: true } });
        if (!hasEnoughSpacedAttempts(calls.map((c) => c.startedAt), settings.calls, tz)) {
          throw new TransitionError(
            "PRECONDITION_FAILED",
            `Requires at least ${settings.calls.minSpacedAttemptsToClose} properly spaced attempts across ${settings.calls.minSlotsToClose} time slots`,
            { requirement: req.kind },
          );
        }
        break;
      }
      case "UNREACHABLE_READY": {
        const total = await db.callAttempt.count({ where: { orderId: order.id } });
        if (order.attemptCount < settings.calls.maxAttemptsPerRound && total < settings.calls.maxAttemptsTotal) {
          throw new TransitionError("PRECONDITION_FAILED", `Requires ${settings.calls.maxAttemptsPerRound} logged attempts (has ${order.attemptCount})`, { requirement: req.kind });
        }
        const answered = await db.callAttempt.count({ where: { orderId: order.id, round: order.recycleRound, outcome: "ANSWERED" } });
        if (answered > 0) throw new TransitionError("PRECONDITION_FAILED", "The customer answered in this round; an agent must decide", { requirement: req.kind });
        break;
      }
      case "LOCK_OWNER": {
        if (ctx.kind === "system" || isSupervisorPlus(ctx)) break;
        if (lockedByOther(order, ctx.userId, settings.lifecycle.lockTimeoutMin)) {
          throw new TransitionError("ORDER_LOCKED", "Another agent is working on this order", { requirement: req.kind });
        }
        break;
      }
      case "LOCK_PREVIOUS_STATUS": {
        const expected = order.lockPrevStatus ?? "ASSIGNEE";
        if (to !== expected) throw new TransitionError("PRECONDITION_FAILED", `The lock returns the order to ${expected}`, { requirement: req.kind, expected });
        break;
      }
      case "RECYCLE_AVAILABLE": {
        if (order.recycleRound >= settings.lifecycle.maxRecycleRounds) {
          throw new TransitionError("PRECONDITION_FAILED", "The recycle round was already used", { requirement: req.kind });
        }
        const since = order.expiredAt ?? order.lastActivityAt;
        if (ctx.kind === "system" && Date.now() - since.getTime() < settings.lifecycle.recycleCooldownDays * 86_400_000) {
          throw new TransitionError("PRECONDITION_FAILED", "Recycle cool-down has not passed", { requirement: req.kind });
        }
        const target = payload.assignedToId as string;
        const previousAgents = await db.callAttempt.findMany({ where: { orderId: order.id }, select: { agentId: true }, distinct: ["agentId"] });
        if (target === order.assignedToId || (ctx.kind === "system" && previousAgents.some((a) => a.agentId === target))) {
          throw new TransitionError("PRECONDITION_FAILED", "A recycled order goes to a different agent", { requirement: req.kind });
        }
        break;
      }
      case "PAYLOAD_CALL_ANSWERED": {
        const call = payload.call as { outcome: string; proof: string; durationSec?: number };
        if (call.outcome !== "ANSWERED") throw new TransitionError("PRECONDITION_FAILED", "Requires an answered re-confirmation call", { requirement: req.kind });
        if (call.proof === "NONE" && !manualProofAllowed(settings)) {
          throw new TransitionError("PRECONDITION_FAILED", "A call without proof is rejected (manual mode is disabled)", { requirement: "CALL_PROOF" });
        }
        break;
      }
      case "CONFIRMED_POSTPONE_WINDOW": {
        const until = payload.deliverOn as Date;
        if (until.getTime() < Date.now() - 60_000) throw new TransitionError("INVALID_PAYLOAD", "The delivery date must be in the future", { requirement: req.kind });
        if (until.getTime() > addDays(new Date(), settings.lifecycle.confirmedPostponeMaxDays).getTime() + 60_000) {
          throw new TransitionError("INVALID_PAYLOAD", `The delivery date cannot be more than ${settings.lifecycle.confirmedPostponeMaxDays} days ahead`, { requirement: req.kind });
        }
        break;
      }
      case "STOCK_ZERO": {
        const items = await db.orderItem.findMany({ where: { orderId: order.id }, select: { productId: true, variantId: true } });
        const stock = items.length
          ? await db.stockItem.findMany({
              where: { OR: items.map((i) => ({ productId: i.productId, variantId: i.variantId ?? null })), warehouse: { merchantId: order.merchantId } },
              select: { onHand: true, reserved: true },
            })
          : [];
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
        const mandatory = settings.mandatoryCancelNote && payload.cancelReason !== undefined;
        if ((reason === "OTHER" || mandatory) && !note) {
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
  STOPDESK_SANS_REPONSE: "RESCUE_NO_ANSWER",
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

/** Next outbound number for this order: A → B → C rotation over active, non-burned numbers of the team org. */
export async function pickOutboundNumber(db: DbClient, teamOrgId: string | null, orderId: string): Promise<string | undefined> {
  if (!teamOrgId) return undefined;
  const numbers = await db.outboundNumber.findMany({ where: { orgId: teamOrgId, active: true, burnedAt: null }, orderBy: { label: "asc" }, select: { id: true } });
  if (numbers.length === 0) return undefined;
  const last = await db.callAttempt.findFirst({ where: { orderId, phoneNumberId: { not: null } }, orderBy: { startedAt: "desc" }, select: { phoneNumberId: true } });
  const idx = last ? numbers.findIndex((n) => n.id === last.phoneNumberId) : -1;
  return numbers[(idx + 1) % numbers.length]!.id;
}

interface ApplyResult {
  data: Prisma.OrderUpdateInput;
  eventPayload: Record<string, unknown>;
  eventType?: string;
}

type CallPayload = {
  outcome: string;
  proof: string;
  startedAt?: Date;
  durationSec?: number;
  phoneNumberId?: string;
  recordingUrl?: string;
  callbackAt?: Date;
  note?: string;
  agentId?: string;
};

async function recordCall(
  db: DbClient,
  order: Order,
  call: CallPayload,
  agentId: string,
  attemptNo: number,
  ops: OpsContext,
): Promise<{ id: string; startedAt: Date }> {
  const startedAt = call.startedAt ?? new Date();
  const phoneNumberId = call.phoneNumberId ?? (await pickOutboundNumber(db, ops.teamOrgId, order.id));
  const created = await db.callAttempt.create({
    data: {
      orderId: order.id,
      agentId,
      phoneNumberId,
      attemptNo,
      round: order.recycleRound,
      day: attemptDayOf(attemptNo),
      slot: slotFor(startedAt, ops.timezone),
      startedAt,
      durationSec: call.durationSec,
      outcome: call.outcome as never,
      proof: call.proof as never,
      recordingUrl: call.recordingUrl,
      note: call.note,
    },
  });
  return { id: created.id, startedAt };
}

/** Rule-specific writes. Keeps every status-specific field change in one place. */
async function applyRule(
  db: DbClient,
  rule: TransitionRule,
  ctx: ActorContext,
  order: Order,
  to: OrderStatus,
  payload: Record<string, unknown>,
  ops: OpsContext,
): Promise<ApplyResult> {
  const { settings, timezone: tz } = ops;
  const now = new Date();
  const actorId = ctx.kind === "user" ? ctx.userId : null;
  let flags = [...order.flags];
  const data: Prisma.OrderUpdateInput = {};
  const eventPayload: Record<string, unknown> = { ...payload };
  let eventType: string | undefined;

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
      const p = payload as { call: CallPayload };
      const attemptNo = order.attemptCount + 1;
      const agentId = p.call.agentId ?? actorId ?? order.assignedToId;
      if (!agentId) throw new TransitionError("INVALID_PAYLOAD", "call.agentId is required when the system logs a call");
      const call = await recordCall(db, order, p.call, agentId, attemptNo, ops);
      data.attemptCount = attemptNo;
      data.attemptDay = attemptDayOf(attemptNo);
      data.lastAttemptAt = call.startedAt;
      if (p.call.proof === "NONE") flags = addFlag(flags, "MANUAL_PROOF");
      if (p.call.outcome === "CALLBACK_REQUESTED" && p.call.callbackAt) {
        data.nextActionAt = p.call.callbackAt;
        flags = addFlag(flags, "CALLBACK");
      } else if (p.call.outcome !== "ANSWERED" && attemptNo < settings.calls.maxAttemptsPerRound) {
        const previous = [...(await roundAttemptDates(db, order))];
        data.nextActionAt = planAttempt({ attemptNo: attemptNo + 1, previous, orderCreatedAt: order.createdAt, cfg: settings.calls, tz });
        flags = removeFlag(flags, "CALLBACK");
      } else {
        data.nextActionAt = p.call.outcome === "ANSWERED" ? null : now;
        flags = removeFlag(flags, "CALLBACK");
      }
      if (p.call.outcome === "WRONG_NUMBER") flags = addFlag(flags, "WRONG_NUMBER_REPORTED");
      eventPayload.callAttemptId = call.id;
      eventPayload.attemptNo = attemptNo;
      eventPayload.round = order.recycleRound;
      eventPayload.outcome = p.call.outcome;
      break;
    }
    case "CONFIRM":
    case "STOCK_BACK": {
      const p = payload as { note?: string; upsells?: Array<{ kind: "UPSELL" | "CROSS_SELL"; items: Array<{ productId: string; variantId?: string | null; qty: number; unitPrice?: number }> }> };
      if (rule.id === "CONFIRM" && actorId) data.confirmedBy = { connect: { id: actorId } };
      data.confirmedAt = order.confirmedAt ?? now;
      data.nextActionAt = null;
      data.postponedUntil = null;
      if (p.note) data.note = p.note;
      flags = removeFlag(flags, "WAITING_STOCK");
      if (p.upsells && p.upsells.length > 0) {
        let upsellValue = order.upsellValue;
        let crossSellValue = order.crossSellValue;
        let added = 0;
        for (const u of p.upsells) {
          const products = await db.product.findMany({ where: { merchantId: order.merchantId, id: { in: u.items.map((i) => i.productId) } }, select: { id: true, price: true } });
          const priceOf = new Map(products.map((x) => [x.id, x.price]));
          for (const it of u.items) {
            const base = priceOf.get(it.productId);
            if (base === undefined) throw new TransitionError("INVALID_PAYLOAD", `Upsell product ${it.productId} not found for this merchant`);
            const unitPrice = it.unitPrice ?? base;
            await db.orderItem.create({ data: { orderId: order.id, productId: it.productId, variantId: it.variantId ?? null, qty: it.qty, unitPrice } });
            const value = unitPrice * it.qty;
            added += value;
            if (u.kind === "UPSELL") upsellValue += value;
            else crossSellValue += value;
          }
          flags = addFlag(flags, u.kind === "UPSELL" ? "UPSELL" : "CROSS_SELL");
        }
        data.upsellValue = upsellValue;
        data.crossSellValue = crossSellValue;
        data.subtotal = order.subtotal + added;
        data.total = order.total + added;
        eventPayload.upsellAdded = added;
      }
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
      const risky = flags.includes("HIGH_VALUE") || settings.riskyWilayas.includes(order.wilayaCode) || flags.includes("REPEAT_REFUSER");
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
    case "CANCEL":
    case "SOURCE_CANCEL": {
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
      const p = payload as { note?: string; blacklistRequest?: boolean; fakeReason: string };
      if (p.note) data.reasonNote = p.note;
      data.fakeReason = p.fakeReason as never;
      flags = removeFlag(flags, "FAKE_PROPOSED");
      if (p.blacklistRequest) flags = addFlag(flags, "BLACKLIST_REQUESTED");
      data.nextActionAt = null;
      break;
    }
    case "UNREACHABLE":
      data.nextActionAt = null;
      break;
    case "CLAIM": {
      const lockOwner = actorId ?? order.assignedToId;
      if (!lockOwner) throw new TransitionError("INVALID_PAYLOAD", "A claim needs an agent");
      data.lockedBy = { connect: { id: lockOwner } };
      data.lockedAt = now;
      data.lockPrevStatus = order.status;
      eventType = "LOCK";
      break;
    }
    case "LOCK_RELEASE": {
      const p = payload as { reason?: string };
      eventType = p.reason === "TIMEOUT" ? "LOCK_TIMEOUT" : "UNLOCK";
      break;
    }
    case "CONFIRM_POSTPONED": {
      const p = payload as { deliverOn: Date; note?: string };
      if (actorId) data.confirmedBy = { connect: { id: actorId } };
      data.confirmedAt = order.confirmedAt ?? now;
      data.postponedUntil = p.deliverOn;
      data.nextActionAt = p.deliverOn;
      if (p.note) data.note = p.note;
      break;
    }
    case "RECONFIRM":
    case "RECONFIRM_CANCEL": {
      const p = payload as { call: CallPayload; cancelReason?: string; reasonNote?: string; note?: string };
      const agentId = p.call.agentId ?? actorId ?? order.assignedToId;
      if (!agentId) throw new TransitionError("INVALID_PAYLOAD", "call.agentId is required");
      const total = await db.callAttempt.count({ where: { orderId: order.id } });
      const call = await recordCall(db, order, p.call, agentId, total + 1, ops);
      eventPayload.callAttemptId = call.id;
      data.nextActionAt = null;
      data.postponedUntil = null;
      if (rule.id === "RECONFIRM") {
        if (!order.confirmedById && actorId) data.confirmedBy = { connect: { id: actorId } };
        if (p.note) data.note = p.note;
        const followUp = await followUpUserFor(db, order);
        if (followUp) {
          data.assignedTo = { connect: { id: followUp } };
          eventPayload.handedOffTo = followUp;
        }
      } else {
        data.cancelReason = p.cancelReason as never;
        data.reasonNote = p.reasonNote ?? null;
      }
      break;
    }
    case "EXPIRE":
      data.expiredAt = now;
      data.nextActionAt = null;
      eventType = "EXPIRE";
      break;
    case "RECYCLE": {
      const p = payload as { assignedToId: string; podId?: string | null };
      data.assignedTo = { connect: { id: p.assignedToId } };
      if (p.podId) data.pod = { connect: { id: p.podId } };
      data.recycleRound = order.recycleRound + 1;
      data.attemptCount = 0;
      data.attemptDay = 0;
      data.nextActionAt = now;
      flags = addFlag(flags, "RECYCLED");
      eventPayload.fromUserId = order.assignedToId;
      eventType = "RECYCLE";
      break;
    }
    case "READY_TO_SHIP":
    case "PACKED":
    case "DELAYED_RESUMED":
      break;
    case "PARCEL_CREATED": {
      const p = payload as { trackingNumber?: string; courierId?: string; labelUrl?: string };
      if (p.trackingNumber) data.trackingNumber = p.trackingNumber;
      if (p.courierId) data.courier = { connect: { id: p.courierId } };
      if (p.labelUrl) data.labelUrl = p.labelUrl;
      data.lastSendFailure = null;
      break;
    }
    case "SHIPPING_DELAYED": {
      const p = payload as { reason: string; releaseStock: boolean };
      flags = addFlag(flags, "SHIPPING_DELAYED");
      if (p.releaseStock) flags = addFlag(flags, "STOCK_RELEASED");
      eventPayload.reason = p.reason;
      break;
    }
    case "DELAYED_CANCELLED": {
      const p = payload as { cancelReason: string; reasonNote?: string };
      data.cancelReason = p.cancelReason as never;
      data.reasonNote = p.reasonNote ?? null;
      break;
    }
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
  return { data, eventPayload, eventType };
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
    const ops = await loadOpsContext(tx, order);
    // Ownership lock (section 19b.2): with distribution on, agents act only on their own orders.
    if (ops.settings.assignment.ownershipLock && ctx.kind === "user" && AGENT_ROLES.includes(ctx.role) && !isSupervisorPlus(ctx) && order.assignedToId && order.assignedToId !== ctx.userId) {
      throw new TransitionError("NOT_ORDER_OWNER", "This order is assigned to another agent");
    }
    await checkRequirements(tx, rule, ctx, order, input.to, payload, ops);
    const { data, eventPayload, eventType } = await applyRule(tx, rule, ctx, order, input.to, payload, ops);
    // Any action other than the claim itself releases the claim/lock.
    const lockReset: Prisma.OrderUpdateInput = rule.id === "CLAIM" || (!order.lockedById && !order.lockPrevStatus) ? {} : { lockedBy: { disconnect: true }, lockedAt: null, lockPrevStatus: null };

    const updated = await tx.order.update({
      where: { id: order.id, merchantId: order.merchantId },
      data: { ...lockReset, ...data, status: input.to, statusGroup: statusGroupOf(input.to), lastActivityAt: new Date() },
    });
    const event = await tx.orderEvent.create({
      data: {
        orderId: order.id,
        actorId: ctx.kind === "user" ? ctx.userId : null,
        type: eventType ?? "STATUS_CHANGE",
        fromStatus: order.status,
        toStatus: input.to,
        payload: sanitizeForJson({ ruleId: rule.id, actor: role, ...eventPayload }),
      },
    });
    return { order: updated, event, ruleId: rule.id, sideEffects: rule.sideEffects, payload: { ...payload, ...eventPayload } };
  });
  const result = ctx.kind === "system" ? await withSystemContext(ctx.reason, run) : await run();

  await dispatchSideEffects({ ctx, order: result.order, event: result.event, sideEffects: result.sideEffects as readonly SideEffect[], payload: sanitizeForJson(result.payload) as Record<string, unknown> });
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
        lockedById: null,
        lockedAt: null,
        lockPrevStatus: null,
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
export async function proposeFakeOrder(ctx: TenantContext, input: { orderId: string; note: string; fakeReason?: string }): Promise<OrderEvent> {
  if (isReadOnly(ctx)) throw new ForbiddenError("Read-only role");
  return prisma.$transaction(async (tx) => {
    const order = await loadOrder(tx, ctx, input.orderId);
    const calls = await tx.callAttempt.count({ where: { orderId: order.id } });
    if (calls === 0 && input.fakeReason !== "INVALID_PHONE") throw new TransitionError("PRECONDITION_FAILED", "Log a call before proposing a fake order");
    await tx.order.update({
      where: { id: order.id, merchantId: order.merchantId },
      data: {
        flags: addFlag(order.flags, "FAKE_PROPOSED"),
        ...(input.fakeReason ? { fakeReason: input.fakeReason as never } : {}),
        lastActivityAt: new Date(),
        lockedById: null,
        lockedAt: null,
      },
    });
    await tx.task.create({ data: { orderId: order.id, type: "VERIFY_ORDER", dueAt: addHours(new Date(), 24) } });
    return tx.orderEvent.create({
      data: { orderId: order.id, actorId: ctx.userId, type: "NOTE", payload: { note: input.note, proposal: "FAUSSE_COMMANDE", fakeReason: input.fakeReason ?? null } },
    });
  });
}

// ─────────────────────────────── claim / lock ───────────────────────────────

/** The agent opens an order from the queue: EN_COURS_CONFIRMATION, locked to them (section 19c.2). */
export async function claimOrder(ctx: TenantContext, orderId: string): Promise<TransitionResult> {
  return transitionOrder(ctx, { orderId, to: "EN_COURS_CONFIRMATION", payload: {} });
}

/** Release a claim back to the status it came from (agent skipped, or timeout via the scheduler). */
export async function releaseLock(ctx: ActorContext, orderId: string, reason: "TIMEOUT" | "SKIPPED" | "RELEASED" = "RELEASED"): Promise<TransitionResult | null> {
  const order = await (ctx.kind === "system"
    ? withSystemContext(ctx.reason, () => prisma.order.findFirst({ where: { id: orderId } }))
    : prisma.order.findFirst({ where: { AND: [{ id: orderId }, orderAccessWhere(ctx)] } }));
  if (!order || order.status !== "EN_COURS_CONFIRMATION") return null;
  return transitionOrder(ctx, { orderId, to: order.lockPrevStatus ?? "ASSIGNEE", payload: { reason } });
}

// ─────────────────────────────── comments ───────────────────────────────

export const COMMENT_TAGS = ["NRP", "SMS_ENVOYE", "COULEUR_TAILLE", "LIVREUR", "SUIVI", "ADRESSE", "PRIX", "RAPPEL"] as const;
export type CommentTag = (typeof COMMENT_TAGS)[number];

/**
 * Structured comment (section 19c.6). Allowed at every stage, including for CLIENT_VIEWER in
 * managed mode (the merchant can comment, never change a status).
 */
export async function addComment(ctx: TenantContext, input: { orderId: string; body: string; tags?: string[] }) {
  const body = input.body.trim();
  const tags = [...new Set((input.tags ?? []).filter((t): t is CommentTag => (COMMENT_TAGS as readonly string[]).includes(t)))];
  if (!body && tags.length === 0) throw new TransitionError("INVALID_PAYLOAD", "Comment cannot be empty");
  if (ctx.role === "READ_ONLY" || ctx.role === "MARKETER") throw new ForbiddenError("Read-only role");
  const order = await prisma.order.findFirst({ where: { AND: [{ id: input.orderId }, orderAccessWhere(ctx)] }, select: { id: true, merchantId: true, statusGroup: true } });
  if (!order) throw new TransitionError("ORDER_NOT_FOUND", "Order not found");
  return prisma.comment.create({ data: { orderId: order.id, authorId: ctx.userId, stage: order.statusGroup, tags, body: body || tags.join(" + ") } });
}

// ─────────────────────────────── creation ───────────────────────────────

export interface CreateOrderInput {
  merchantId: string;
  storeId: string;
  externalId?: string | null;
  customer: { name?: string | null; phone: string; phone2?: string | null };
  wilaya: number | string | null;
  commune?: string | null;
  address?: string | null;
  address2?: string | null;
  landmark?: string | null;
  deliveryType?: "HOME" | "STOP_DESK";
  items: Array<{ productId: string; variantId?: string | null; qty: number; unitPrice?: number }>;
  /** lines whose SKU is not in the catalog (section 19c.4) */
  unmatched?: Array<{ externalSku: string; productName: string; variantName?: string | null; qty: number; unitPrice?: number | null }>;
  shippingFee?: number;
  /** total from the source platform (Shopify etc.); defaults to items + shipping */
  totalOverride?: number | null;
  freeDelivery?: boolean;
  abandonedCartRecovery?: boolean;
  source?: string | null;
  note?: string | null;
  flags?: string[];
  clientIp?: string | null;
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

/** Intake refused (blacklisted phone in REFUSE mode, non-Algerian number…). */
export class IntakeRefusedError extends Error {
  readonly code = "INTAKE_REFUSED";
  constructor(public readonly reason: "BLACKLISTED" | "NON_ALGERIAN_PHONE", message: string) {
    super(message);
    this.name = "IntakeRefusedError";
  }
}

async function loadCommuneRefs(db: DbClient, commune: string | null | undefined, wilayaCode: number | null): Promise<CommuneRef[]> {
  const or: Prisma.CommuneWhereInput[] = [];
  if (commune?.trim()) {
    or.push({ nameFr: { equals: commune.trim(), mode: "insensitive" } }, { nameAr: commune.trim() });
  }
  if (wilayaCode) or.push({ wilayaCode });
  if (or.length === 0) return [];
  return db.commune.findMany({ where: { OR: or }, select: { wilayaCode: true, nameFr: true, nameAr: true }, take: 2000 });
}

/** Phone blacklisted for this merchant (customer flag) or by an agency serving it (Blacklist table). */
async function isBlacklisted(db: DbClient, merchantId: string, phone: string): Promise<boolean> {
  const contracts = await db.serviceContract.findMany({ where: { merchantId, status: { in: ["TRIAL", "ACTIVE"] } }, select: { agencyId: true } });
  const orgIds = [merchantId, ...contracts.map((c) => c.agencyId)];
  const hit = await db.blacklist.findFirst({ where: { orgId: { in: orgIds }, phone }, select: { id: true } });
  return !!hit;
}

/**
 * Create an order (section 7.3 first row + section 19c.4 intake): phone normalization, address
 * validation with auto-repair, fake signals, blacklist, unmatched SKUs, customer upsert, repeat
 * badge, sequence number, duplicate detection, HIGH_VALUE flag, audit event. Every ingestion
 * adapter (Shopify, DZBuild, API, Sheets, manual form, import) ends here.
 */
export async function createOrder(ctx: ActorContext, input: CreateOrderInput): Promise<Order> {
  if (ctx.kind === "user") {
    if (isReadOnly(ctx)) throw new ForbiddenError("Read-only role");
    if (!ctx.accessibleMerchantIds.includes(input.merchantId)) throw new ForbiddenError("No access to this merchant");
  }
  const unmatched = input.unmatched ?? [];
  if (input.items.length === 0 && unmatched.length === 0) throw new OrderValidationError("An order needs at least one item");

  const phone = normalizePhone(input.customer.phone);
  const phone2 = input.customer.phone2 ? normalizePhone(input.customer.phone2) : null;
  const customerPhone = phone.phone ?? input.customer.phone.replace(/\D/g, "").slice(0, 20);
  if (!customerPhone) throw new OrderValidationError("A phone number is required");

  const createTx = () => prisma.$transaction(async (tx) => {
    const store = await tx.store.findFirst({ where: { id: input.storeId, merchantId: input.merchantId }, select: { id: true } });
    if (!store) throw new OrderValidationError("Store not found for this merchant");

    const merchantOrg = await tx.organization.findUnique({ where: { id: input.merchantId }, select: { settings: true } });
    const settings = parseOrgSettings(merchantOrg?.settings);
    const flags = new Set(input.flags ?? []);
    const mappingErrors = new Set<MappingError>();
    const problems: string[] = [];

    // ── phone ──
    if (!phone.valid) {
      flags.add("INVALID_PHONE");
      mappingErrors.add("INVALID_PHONE");
      problems.push("invalid phone");
    }

    // ── blacklist ──
    const banned = phone.phone ? await isBlacklisted(tx, input.merchantId, phone.phone) : false;
    if (banned && settings.intake.blacklistMode === "REFUSE") throw new IntakeRefusedError("BLACKLISTED", "This phone number is blacklisted");

    // ── address (wilaya / commune / address) with auto-repair ──
    const firstGuess = typeof input.wilaya === "number" ? input.wilaya : null;
    const communes = await loadCommuneRefs(tx, input.commune, firstGuess);
    const addr = validateAddress(
      { wilaya: input.wilaya, commune: input.commune, address: input.address, address2: input.address2, landmark: input.landmark, deliveryType: input.deliveryType },
      communes,
    );
    for (const e of addr.errors) mappingErrors.add(e);
    if (addr.repaired) flags.add("ADDRESS_REPAIRED");
    if (!addr.wilayaCode) flags.add("UNKNOWN_WILAYA");
    if (addr.errors.length > 0) problems.push(...addr.notes, ...addr.errors.filter((e) => e === "ADDRESS_EMPTY").map(() => "empty address"));

    // ── fake signals ──
    const fakeSignals = detectFakeSignals({ name: input.customer.name, phone: input.customer.phone, note: input.note });
    if (fakeSignals.length > 0) flags.add("FAKE_SUSPECT");

    // ── items, unmatched lines and totals ──
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
    if (unmatched.length > 0) {
      mappingErrors.add("UNMATCHED_SKU");
      flags.add("UNMATCHED");
      problems.push(`${unmatched.length} unmatched SKU line(s)`);
    }
    const subtotal = items.reduce((acc, i) => acc + i.qty * i.unitPrice, 0) + unmatched.reduce((acc, u) => acc + u.qty * (u.unitPrice ?? 0), 0);
    const shippingFee = input.freeDelivery ? 0 : input.shippingFee ?? 0;
    const total = input.totalOverride ?? subtotal + shippingFee;

    const org = await tx.organization.update({ where: { id: input.merchantId }, data: { orderSeq: { increment: 1 } }, select: { orderSeq: true } });
    if (total >= settings.highValueThreshold) flags.add("HIGH_VALUE");

    const customer = await tx.customer.upsert({
      where: { merchantId_phone: { merchantId: input.merchantId, phone: customerPhone } },
      create: { merchantId: input.merchantId, phone: customerPhone, phone2: phone2?.phone ?? null, name: input.customer.name ?? null, ordersCount: 1, blacklisted: banned },
      update: {
        ordersCount: { increment: 1 },
        ...(input.customer.name ? { name: input.customer.name } : {}),
        ...(phone2?.phone ? { phone2: phone2.phone } : {}),
        ...(banned ? { blacklisted: true } : {}),
      },
    });
    if (customer.blacklisted || banned) flags.add("BLACKLISTED_CUSTOMER");
    if (customer.refusedCount >= 2) {
      flags.add("REPEAT_REFUSER");
      if (!fakeSignals.includes("REPEAT_REFUSER")) fakeSignals.push("REPEAT_REFUSER");
    }
    const isRepeatCustomer = customer.ordersCount > 1;

    const blocking = [...mappingErrors].filter((e) => e !== "UNMATCHED_SKU" || items.length === 0);
    const initialStatus: OrderStatus = blocking.length > 0 || mappingErrors.has("UNMATCHED_SKU") ? "A_VERIFIER" : "NOUVEAU";

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
        wilayaCode: addr.wilayaCode ?? 16,
        commune: addr.commune,
        address: input.address ?? null,
        address2: input.address2 ?? null,
        landmark: input.landmark ?? null,
        deliveryType: input.deliveryType ?? "HOME",
        subtotal,
        shippingFee,
        total,
        source: input.source ?? null,
        note: input.note ?? null,
        reasonNote: problems.length > 0 ? `Intake check: ${problems.join("; ")}` : null,
        flags: [...flags],
        mappingErrors: [...mappingErrors],
        fakeReason: fakeSignals[0] ?? null,
        isRepeatCustomer,
        freeDelivery: input.freeDelivery ?? false,
        abandonedCartRecovery: input.abandonedCartRecovery ?? false,
        clientIp: input.clientIp ?? null,
        createdAt: input.createdAt,
        lastActivityAt: input.createdAt ?? new Date(),
        items: { create: items },
        unmatchedLines: unmatched.length
          ? { create: unmatched.map((u) => ({ externalSku: u.externalSku, productName: u.productName, variantName: u.variantName ?? null, qty: u.qty, unitPrice: u.unitPrice ?? 0 })) }
          : undefined,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        actorId: ctx.kind === "user" ? ctx.userId : null,
        type: "STATUS_CHANGE",
        fromStatus: null,
        toStatus: initialStatus,
        payload: sanitizeForJson({ ruleId: "CREATE", source: input.source ?? null, externalId: input.externalId ?? null, problems, mappingErrors: [...mappingErrors], fakeSignals }),
        createdAt: input.createdAt,
      },
    });
    if (initialStatus === "A_VERIFIER") {
      await tx.task.create({ data: { orderId: order.id, type: "VERIFY_ORDER", dueAt: addHours(new Date(), 24) } });
    }

    // Duplicate detection: same customer + same product within the window, previous order still alive.
    let duplicateOfId: string | null = null;
    if (!input.skipDuplicateCheck && initialStatus === "NOUVEAU" && items.length > 0) {
      const since = addHours(order.createdAt, -settings.intake.duplicateWindowHours);
      const previous = await tx.order.findFirst({
        where: {
          merchantId: input.merchantId,
          customerId: customer.id,
          id: { not: order.id },
          createdAt: { gte: since },
          status: { notIn: ["ANNULEE", "DOUBLE", "FAUSSE_COMMANDE", "INJOIGNABLE", "EXPIREE"] },
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
    sideEffects: created.order.status === "NOUVEAU" ? ["AUTO_ASSIGN", "BOT_CONFIRM_REQUEST"] : [],
    payload: { ruleId: "CREATE" },
  });
  return created.order;
}
