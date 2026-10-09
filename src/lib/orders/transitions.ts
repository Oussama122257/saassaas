import { z } from "zod";
import type { OrderStatus, Role } from "@prisma/client";
import { CLAIMABLE_STATUSES, CONFIRMATION_OPEN_STATUSES, EXPIRABLE_STATUSES, IN_TRANSIT_STATUSES } from "./statuses";

/**
 * Transition table (section 7.3) as data. The service in orderTransitions.ts is the only code
 * allowed to change Order.status; it looks rules up here, validates the payload with the rule's
 * Zod schema, checks the declarative requirements and runs the side effects.
 */
export type TransitionActor = Role | "SYSTEM";

export const AGENT_ACTORS: readonly TransitionActor[] = ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR", "ORG_OWNER"];
export const SUPERVISOR_ACTORS: readonly TransitionActor[] = ["SUPERVISOR", "ORG_OWNER", "PLATFORM_ADMIN"];
export const WAREHOUSE_ACTORS: readonly TransitionActor[] = ["WAREHOUSE", "SUPERVISOR", "ORG_OWNER"];
export const SYSTEM_ONLY: readonly TransitionActor[] = ["SYSTEM"];

export type SideEffect =
  | "SCHEDULE_NEXT_ATTEMPT"
  | "SEND_WRITTEN_CONFIRMATION"
  | "RESERVE_STOCK"
  | "HANDOFF_TO_FOLLOWUP"
  | "WAITING_STOCK_TASK"
  | "NOTIFY_SUPERVISOR"
  | "VERIFY_BOT_IF_RISKY"
  | "QA_SAMPLE_POOL"
  | "SET_NEXT_ACTION"
  | "VERIFY_TASK"
  | "NOTIFY_DUPLICATE"
  | "FINAL_UNREACHABLE_MESSAGE"
  | "PRINT_LABEL"
  | "NOTIFY_STOCK_BACK"
  | "SEND_SHIPPED_MESSAGE"
  | "DELIVERY_TASK"
  | "DELIVERED_STATS"
  | "LINK_RETURN_TO_AGENT"
  | "RESTOCK"
  | "RELEASE_STOCK"
  | "INVOICE_LINE"
  | "OPEN_CLAIM"
  | "MISSED_CALL_MESSAGE"
  | "WRITE_BACK"
  | "QUEUE_REFRESH"
  | "AUTO_ASSIGN"
  | "BOT_CONFIRM_REQUEST";

export type Requirement =
  | { kind: "ANSWERED_CALL"; minDurationSec?: number }
  | { kind: "ANY_LOGGED_CALL" }
  | { kind: "ATTEMPT_COUNT_EQUALS"; value: number }
  | { kind: "ATTEMPT_COUNT_LT"; value: number }
  | { kind: "NEXT_ATTEMPT_STATUS" }
  | { kind: "STOCK_ZERO" }
  | { kind: "NOT_FLAGGED"; flag: string }
  | { kind: "NOTE_IF_OTHER" }
  | { kind: "POSTPONE_MAX_DAYS"; days: number }
  /** cadence rules: slots, blocked windows, hard minimum spacing, attempt caps (section 8 / 19c.1) */
  | { kind: "CALL_TIMING" }
  /** N properly spaced attempts over ≥ M slots (section 19c.1); clear fake reasons are exempt */
  | { kind: "SPACED_ATTEMPTS"; exemptClearFake?: boolean }
  /** 9 attempts in the round, or the cross-round cap reached */
  | { kind: "UNREACHABLE_READY" }
  /** the actor holds the claim/lock (or the lock expired) */
  | { kind: "LOCK_OWNER" }
  /** the target status equals the status the order was claimed from */
  | { kind: "LOCK_PREVIOUS_STATUS" }
  /** recycle round still available and cool-down passed */
  | { kind: "RECYCLE_AVAILABLE" }
  /** the re-confirmation call in the payload is an answered call */
  | { kind: "PAYLOAD_CALL_ANSWERED" }
  | { kind: "CONFIRMED_POSTPONE_WINDOW" };

export interface TransitionRule<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  from: readonly OrderStatus[];
  to: readonly OrderStatus[];
  actors: readonly TransitionActor[];
  schema: S;
  requires: readonly Requirement[];
  sideEffects: readonly SideEffect[];
  description: string;
}

// ─────────────────────────────── payload schemas ───────────────────────────────

const CALL_OUTCOMES = ["ANSWERED", "NO_ANSWER", "BUSY", "OFF", "WRONG_NUMBER", "CALLBACK_REQUESTED"] as const;
const CALL_PROOFS = ["VOIP_LOG", "DEVICE_LOG", "NONE"] as const;
export const CANCEL_REASONS = [
  "CHANGED_MIND",
  "PRICE_TOO_HIGH",
  "SHIPPING_FEE",
  "BOUGHT_ELSEWHERE",
  "PRODUCT_DOUBT",
  "WRONG_PRODUCT_OR_SIZE",
  "DELIVERY_TOO_SLOW",
  "DID_NOT_ORDER",
  "CANCELLED_BY_CUSTOMER",
  "WRONG_INFORMATION",
  "NO_LONGER_INTERESTED",
  "CUSTOMER_ABSENT",
  "OTHER",
] as const;
export const FAKE_REASONS = ["INVALID_PHONE", "NAME_NONSENSE", "DID_NOT_ORDER", "PRANK", "TEST_ORDER", "COMPETITOR", "REPEAT_REFUSER", "OTHER"] as const;
export const RETURN_REASONS = [
  "PRICE_SHOCK",
  "NOT_AS_EXPECTED",
  "BOUGHT_ELSEWHERE",
  "CLIENT_UNREACHABLE",
  "WRONG_ADDRESS",
  "DELIVERY_DELAY",
  "FAKE_CONFIRMATION",
  "CLIENT_ABSENT",
  "DAMAGED",
  "OTHER",
] as const;

export const emptySchema = z.object({}).passthrough();

export const assignSchema = z.object({
  assignedToId: z.string().min(1),
  podId: z.string().min(1).nullable().optional(),
  rule: z.string().optional(),
});

export const duplicateSchema = z.object({ duplicateOfId: z.string().min(1) });

const callObject = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  proof: z.enum(CALL_PROOFS),
  startedAt: z.coerce.date().optional(),
  durationSec: z.number().int().min(0).optional(),
  phoneNumberId: z.string().optional(),
  recordingUrl: z.string().url().optional(),
  note: z.string().max(2000).optional(),
  agentId: z.string().optional(),
});

export const callSchema = z.object({
  call: z.object({
    outcome: z.enum(CALL_OUTCOMES),
    proof: z.enum(CALL_PROOFS),
    startedAt: z.coerce.date().optional(),
    durationSec: z.number().int().min(0).optional(),
    phoneNumberId: z.string().optional(),
    recordingUrl: z.string().url().optional(),
    callbackAt: z.coerce.date().optional(),
    note: z.string().max(2000).optional(),
    /** system-logged calls (telephony webhooks) name the agent explicitly */
    agentId: z.string().optional(),
  }),
});

export const checklistSchema = z.object({
  productExplained: z.literal(true),
  totalStated: z.literal(true),
  addressVerified: z.literal(true),
  variantVerified: z.literal(true),
  explicitYes: z.literal(true),
});

/** Upsell (more units / bigger pack) or cross-sell (another product), only with an explicit yes (section 19c.8). */
export const upsellSchema = z.object({
  kind: z.enum(["UPSELL", "CROSS_SELL"]),
  customerAgreed: z.literal(true),
  items: z.array(z.object({ productId: z.string().min(1), variantId: z.string().nullable().optional(), qty: z.number().int().min(1).max(20), unitPrice: z.number().int().min(0).optional() })).min(1).max(5),
});

export const confirmSchema = z.object({
  checklist: checklistSchema,
  upsells: z.array(upsellSchema).max(3).optional(),
  note: z.string().max(2000).optional(),
});

export const claimSchema = z.object({}).passthrough();
export const lockReleaseSchema = z.object({ reason: z.enum(["TIMEOUT", "SKIPPED", "RELEASED"]).default("RELEASED") });

export const confirmPostponedSchema = z.object({
  checklist: checklistSchema,
  deliverOn: z.coerce.date(),
  note: z.string().max(2000).optional(),
});

export const reconfirmSchema = z.object({ call: callObject, note: z.string().max(2000).optional() });

export const reconfirmCancelSchema = z.object({
  call: callObject,
  cancelReason: z.enum(CANCEL_REASONS),
  reasonNote: z.string().max(2000).optional(),
});

export const expireSchema = z.object({ job: z.string().optional() });

export const recycleSchema = z.object({ assignedToId: z.string().min(1), podId: z.string().nullable().optional(), rule: z.string().optional() });

export const confirmBotSchema = z.object({ messageId: z.string().optional() });

export const cancelSchema = z.object({
  cancelReason: z.enum(CANCEL_REASONS),
  reasonNote: z.string().max(2000).optional(),
});

export const postponeSchema = z.object({
  postponedUntil: z.coerce.date(),
  reason: z.string().min(2).max(500),
});

export const verifySchema = z.object({ comment: z.string().min(3).max(2000) });

export const doubleResolveSchema = z.object({ verificationNote: z.string().min(2).max(2000) });

export const fakeSchema = z.object({
  fakeReason: z.enum(FAKE_REASONS).default("OTHER"),
  note: z.string().max(2000).optional(),
  blacklistRequest: z.boolean().optional(),
});

export const readyToShipSchema = z.object({ packedItemIds: z.array(z.string()).optional() });

export const shippedSchema = z.object({
  trackingNumber: z.string().min(2).max(100),
  courierId: z.string().optional(),
  labelUrl: z.string().url().optional(),
});

export const courierSyncSchema = z.object({
  provider: z.string().optional(),
  rawStatus: z.string().optional(),
  courierEventId: z.string().optional(),
});

export const deliveredSchema = z.object({ deliveredAt: z.coerce.date().optional(), provider: z.string().optional(), rawStatus: z.string().optional() });

export const returnStartSchema = z.object({
  returnReason: z.enum(RETURN_REASONS),
  reasonNote: z.string().max(2000).optional(),
});

export const returnReceivedSchema = z.object({
  condition: z.enum(["OK", "DAMAGED", "MISSING"]),
  note: z.string().max(2000).optional(),
});

export const lostSchema = z.object({ note: z.string().min(2).max(2000) });

export const cashedSchema = z.object({ payoutId: z.string().optional(), amount: z.number().int().min(0).optional() });

export const overrideSchema = z.object({ reason: z.string().min(5).max(2000) });

// ─────────────────────────────── the table ───────────────────────────────

const COURIER_PROGRESS_STATUSES: readonly OrderStatus[] = [
  "ARRIVE_WILAYA",
  "STOP_DESK",
  "EN_LIVRAISON",
  "CLIENT_INJOIGNABLE_LIVREUR",
  "STOPDESK_SANS_REPONSE",
  "EXPEDIE_REPORTE",
  "REPORTE_CLIENT",
  "ADRESSE_ERRONEE",
  "TENTATIVE_ECHOUEE",
  "REFUSE",
  "ALERTE",
];

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    id: "ASSIGN",
    from: ["NOUVEAU"],
    to: ["ASSIGNEE"],
    actors: ["SYSTEM", ...SUPERVISOR_ACTORS],
    schema: assignSchema,
    requires: [],
    sideEffects: ["SCHEDULE_NEXT_ATTEMPT"],
    description: "Assignment engine (or supervisor) gives the order to a confirmation agent",
  },
  {
    id: "DUPLICATE_DETECTED",
    from: ["NOUVEAU"],
    to: ["DOUBLE"],
    actors: SYSTEM_ONLY,
    schema: duplicateSchema,
    requires: [],
    sideEffects: ["NOTIFY_DUPLICATE"],
    description: "Same phone + same product within 48 h",
  },
  {
    id: "LOG_CALL",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["APPEL_1", "APPEL_2", "APPEL_3"],
    actors: ["SYSTEM", ...AGENT_ACTORS],
    schema: callSchema,
    requires: [{ kind: "LOCK_OWNER" }, { kind: "ATTEMPT_COUNT_LT", value: 9 }, { kind: "NEXT_ATTEMPT_STATUS" }, { kind: "CALL_TIMING" }],
    sideEffects: ["SCHEDULE_NEXT_ATTEMPT", "MISSED_CALL_MESSAGE", "WRITE_BACK"],
    description: "Agent logs a call attempt (proof required); APPEL_n is the attempt number within the day",
  },
  {
    id: "CONFIRM",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["CONFIRMEE"],
    actors: AGENT_ACTORS,
    schema: confirmSchema,
    requires: [{ kind: "LOCK_OWNER" }, { kind: "ANSWERED_CALL" }],
    sideEffects: ["SEND_WRITTEN_CONFIRMATION", "RESERVE_STOCK", "HANDOFF_TO_FOLLOWUP", "WRITE_BACK"],
    description: "Confirmation checklist complete and at least one answered call",
  },
  {
    id: "CONFIRM_OUT_OF_STOCK",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["CONFIRMEE_RUPTURE"],
    actors: AGENT_ACTORS,
    schema: confirmSchema,
    requires: [{ kind: "LOCK_OWNER" }, { kind: "ANSWERED_CALL" }, { kind: "STOCK_ZERO" }],
    sideEffects: ["WAITING_STOCK_TASK", "NOTIFY_SUPERVISOR"],
    description: "Customer confirmed but stock is 0",
  },
  {
    id: "CONFIRM_BOT",
    from: ["NOUVEAU", "ASSIGNEE", "EN_COURS_CONFIRMATION", "APPEL_1", "APPEL_2", "APPEL_3"],
    to: ["CONFIRMEE_BOT"],
    actors: SYSTEM_ONLY,
    schema: confirmBotSchema,
    requires: [],
    sideEffects: ["VERIFY_BOT_IF_RISKY", "RESERVE_STOCK"],
    description: "Customer pressed the WhatsApp confirm button",
  },
  {
    id: "CANCEL",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["ANNULEE"],
    actors: AGENT_ACTORS,
    schema: cancelSchema,
    requires: [{ kind: "LOCK_OWNER" }, { kind: "ANSWERED_CALL" }, { kind: "NOTE_IF_OTHER" }],
    sideEffects: ["QA_SAMPLE_POOL", "RELEASE_STOCK", "WRITE_BACK"],
    description: "Customer cancelled on the phone (reason required)",
  },
  {
    id: "POSTPONE",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["REPORTE"],
    actors: AGENT_ACTORS,
    schema: postponeSchema,
    requires: [{ kind: "LOCK_OWNER" }, { kind: "POSTPONE_MAX_DAYS", days: 7 }],
    sideEffects: ["SET_NEXT_ACTION"],
    description: "Customer asked to be called back on a later date (max 7 days)",
  },
  {
    id: "SOURCE_CANCEL",
    from: [...CONFIRMATION_OPEN_STATUSES, "NOUVEAU", "CONFIRMEE", "CONFIRMEE_BOT", "CONFIRMEE_RUPTURE", "CONFIRMEE_REPORTEE"],
    to: ["ANNULEE"],
    actors: SYSTEM_ONLY,
    schema: z.object({ cancelReason: z.enum(CANCEL_REASONS).default("CANCELLED_BY_CUSTOMER"), source: z.string().default("store") }),
    requires: [],
    sideEffects: ["RELEASE_STOCK"],
    description: "Order cancelled in the source store (Shopify orders/cancelled, DZBuild order.cancelled) before shipping",
  },
  {
    id: "TO_VERIFY",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["A_VERIFIER"],
    actors: AGENT_ACTORS,
    schema: verifySchema,
    requires: [{ kind: "LOCK_OWNER" }],
    sideEffects: ["VERIFY_TASK"],
    description: "Something is off; supervisor task with 24 h SLA",
  },
  {
    id: "DUPLICATE_MERGE",
    from: ["DOUBLE"],
    to: ["ANNULEE"],
    actors: AGENT_ACTORS,
    schema: doubleResolveSchema,
    requires: [],
    sideEffects: [],
    description: "Agent checked with the customer: it is a duplicate",
  },
  {
    id: "DUPLICATE_REOPEN",
    from: ["DOUBLE"],
    to: ["ASSIGNEE"],
    actors: AGENT_ACTORS,
    schema: doubleResolveSchema,
    requires: [],
    sideEffects: ["SCHEDULE_NEXT_ATTEMPT"],
    description: "Agent checked with the customer: it is a real second order",
  },
  {
    id: "FAKE_ORDER",
    from: [...CONFIRMATION_OPEN_STATUSES, "DOUBLE"],
    to: ["FAUSSE_COMMANDE"],
    actors: SUPERVISOR_ACTORS,
    schema: fakeSchema,
    requires: [{ kind: "SPACED_ATTEMPTS", exemptClearFake: true }],
    sideEffects: ["RELEASE_STOCK", "WRITE_BACK"],
    description: "Agent proposed (flag FAKE_PROPOSED), supervisor finalizes; needs enough spaced attempts unless the fake reason is clear",
  },
  {
    id: "UNREACHABLE",
    from: ["APPEL_3"],
    to: ["INJOIGNABLE"],
    actors: SYSTEM_ONLY,
    schema: emptySchema,
    requires: [{ kind: "UNREACHABLE_READY" }, { kind: "SPACED_ATTEMPTS" }],
    sideEffects: ["FINAL_UNREACHABLE_MESSAGE", "RELEASE_STOCK", "WRITE_BACK"],
    description: "Scheduler only, after 9 logged attempts over 3 days (or the cross-round cap)",
  },
  {
    id: "CLAIM",
    from: CLAIMABLE_STATUSES,
    to: ["EN_COURS_CONFIRMATION"],
    actors: ["SYSTEM", ...AGENT_ACTORS],
    schema: claimSchema,
    requires: [],
    sideEffects: [],
    description: "Agent opens the order from the queue: locked to them until they act or the lock times out",
  },
  {
    id: "LOCK_RELEASE",
    from: ["EN_COURS_CONFIRMATION"],
    to: CLAIMABLE_STATUSES,
    actors: ["SYSTEM", ...AGENT_ACTORS],
    schema: lockReleaseSchema,
    requires: [{ kind: "LOCK_PREVIOUS_STATUS" }, { kind: "LOCK_OWNER" }],
    sideEffects: ["QUEUE_REFRESH"],
    description: "Lock released (timeout after N minutes with no action, or agent skipped): back to the previous status",
  },
  {
    id: "CONFIRM_POSTPONED",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["CONFIRMEE_REPORTEE"],
    actors: AGENT_ACTORS,
    schema: confirmPostponedSchema,
    requires: [{ kind: "LOCK_OWNER" }, { kind: "ANSWERED_CALL" }, { kind: "CONFIRMED_POSTPONE_WINDOW" }],
    sideEffects: ["SET_NEXT_ACTION", "WRITE_BACK"],
    description: "Customer said yes but wants delivery later: re-queued on that date for a 1-question re-confirmation",
  },
  {
    id: "RECONFIRM",
    from: ["CONFIRMEE_REPORTEE"],
    to: ["CONFIRMEE"],
    actors: AGENT_ACTORS,
    schema: reconfirmSchema,
    requires: [{ kind: "PAYLOAD_CALL_ANSWERED" }],
    sideEffects: ["SEND_WRITTEN_CONFIRMATION", "RESERVE_STOCK", "HANDOFF_TO_FOLLOWUP", "WRITE_BACK"],
    description: "Re-confirmation call on the agreed date: ship",
  },
  {
    id: "RECONFIRM_CANCEL",
    from: ["CONFIRMEE_REPORTEE"],
    to: ["ANNULEE"],
    actors: AGENT_ACTORS,
    schema: reconfirmCancelSchema,
    requires: [{ kind: "PAYLOAD_CALL_ANSWERED" }, { kind: "NOTE_IF_OTHER" }],
    sideEffects: ["QA_SAMPLE_POOL", "WRITE_BACK"],
    description: "Re-confirmation call on the agreed date: the customer cancels",
  },
  {
    id: "EXPIRE",
    from: EXPIRABLE_STATUSES,
    to: ["EXPIREE"],
    actors: SYSTEM_ONLY,
    schema: expireSchema,
    requires: [{ kind: "SPACED_ATTEMPTS" }],
    sideEffects: ["RELEASE_STOCK", "WRITE_BACK"],
    description: "Nightly job (00:00 org time): still unconfirmed after the expiry window",
  },
  {
    id: "RECYCLE",
    from: ["EXPIREE", "INJOIGNABLE"],
    to: ["ASSIGNEE"],
    actors: ["SYSTEM", ...SUPERVISOR_ACTORS],
    schema: recycleSchema,
    requires: [{ kind: "RECYCLE_AVAILABLE" }],
    sideEffects: ["SCHEDULE_NEXT_ATTEMPT"],
    description: "Recycle round: a different agent, new attempt counter (max 1 round by default)",
  },
  {
    id: "READY_TO_SHIP",
    from: ["CONFIRMEE", "CONFIRMEE_BOT"],
    to: ["PRET_A_EXPEDIER"],
    actors: WAREHOUSE_ACTORS,
    schema: readyToShipSchema,
    requires: [{ kind: "NOT_FLAGGED", flag: "NEEDS_VERIFICATION" }],
    sideEffects: ["PRINT_LABEL"],
    description: "Items packed",
  },
  {
    id: "PARCEL_CREATED",
    from: ["CONFIRMEE", "CONFIRMEE_BOT", "EXPEDITION_RETARDEE"],
    to: ["EN_PREPARATION"],
    actors: ["SYSTEM", ...WAREHOUSE_ACTORS],
    schema: z.object({ trackingNumber: z.string().min(2).max(100).optional(), courierId: z.string().optional(), labelUrl: z.string().optional() }),
    requires: [{ kind: "NOT_FLAGGED", flag: "NEEDS_VERIFICATION" }],
    sideEffects: ["PRINT_LABEL"],
    description: "Courier parcel created (tracking + label); the warehouse prepares it",
  },
  {
    id: "PACKED",
    from: ["EN_PREPARATION"],
    to: ["PRET_A_EXPEDIER"],
    actors: ["SYSTEM", ...WAREHOUSE_ACTORS],
    schema: readyToShipSchema,
    requires: [],
    sideEffects: ["PRINT_LABEL"],
    description: "Items packed, label printed",
  },
  {
    id: "SHIPPING_DELAYED",
    from: ["CONFIRMEE", "CONFIRMEE_BOT", "EN_PREPARATION", "PRET_A_EXPEDIER"],
    to: ["EXPEDITION_RETARDEE"],
    actors: ["SYSTEM", ...SUPERVISOR_ACTORS],
    schema: z.object({ reason: z.string().max(500).default("stuck"), releaseStock: z.boolean().default(false) }),
    requires: [],
    sideEffects: ["NOTIFY_SUPERVISOR"],
    description: "Stuck-order watchdog (or supervisor bulk action): pre-shipping beyond the threshold; optional stock release",
  },
  {
    id: "DELAYED_RESUMED",
    from: ["EXPEDITION_RETARDEE"],
    to: ["PRET_A_EXPEDIER"],
    actors: WAREHOUSE_ACTORS,
    schema: readyToShipSchema,
    requires: [],
    sideEffects: ["RESERVE_STOCK"],
    description: "Delayed order packed after all",
  },
  {
    id: "DELAYED_CANCELLED",
    from: ["EXPEDITION_RETARDEE"],
    to: ["ANNULEE"],
    actors: SUPERVISOR_ACTORS,
    schema: cancelSchema,
    requires: [{ kind: "NOTE_IF_OTHER" }],
    sideEffects: ["RELEASE_STOCK", "WRITE_BACK"],
    description: "Delayed order cancelled after calling the customer",
  },
  {
    id: "STOCK_BACK",
    from: ["CONFIRMEE_RUPTURE"],
    to: ["CONFIRMEE"],
    actors: SYSTEM_ONLY,
    schema: emptySchema,
    requires: [],
    sideEffects: ["NOTIFY_STOCK_BACK", "RESERVE_STOCK", "HANDOFF_TO_FOLLOWUP"],
    description: "Stock is back; customer and agent notified",
  },
  {
    id: "SHIPPED",
    from: ["PRET_A_EXPEDIER"],
    to: ["EXPEDIE"],
    actors: ["SYSTEM", ...WAREHOUSE_ACTORS],
    schema: shippedSchema,
    requires: [],
    sideEffects: ["SEND_SHIPPED_MESSAGE"],
    description: "Courier picked the parcel up (tracking number required)",
  },
  {
    id: "COURIER_SYNC",
    from: IN_TRANSIT_STATUSES,
    to: COURIER_PROGRESS_STATUSES,
    actors: SYSTEM_ONLY,
    schema: courierSyncSchema,
    requires: [],
    sideEffects: ["DELIVERY_TASK"],
    description: "Courier status update; creates follow-up tasks per section 10",
  },
  {
    id: "DELIVERED",
    from: IN_TRANSIT_STATUSES,
    to: ["LIVRE"],
    actors: SYSTEM_ONLY,
    schema: deliveredSchema,
    requires: [],
    sideEffects: ["DELIVERED_STATS"],
    description: "Courier reports delivered",
  },
  {
    id: "RETURN_STARTED",
    from: IN_TRANSIT_STATUSES,
    to: ["RETOUR_EN_COURS"],
    actors: SYSTEM_ONLY,
    schema: returnStartSchema,
    requires: [{ kind: "NOTE_IF_OTHER" }],
    sideEffects: ["LINK_RETURN_TO_AGENT"],
    description: "Refused or failed after N attempts; return linked to confirmedById",
  },
  {
    id: "RETURN_RECEIVED",
    from: ["RETOUR_EN_COURS"],
    to: ["RETOUR_RECU"],
    actors: WAREHOUSE_ACTORS,
    schema: returnReceivedSchema,
    requires: [],
    sideEffects: ["RESTOCK"],
    description: "Warehouse scanned the returned parcel and checked its condition",
  },
  {
    id: "LOST_OR_DAMAGED",
    from: [...IN_TRANSIT_STATUSES, "RETOUR_EN_COURS"],
    to: ["PERDU_ENDOMMAGE"],
    actors: ["SYSTEM", "SUPERVISOR", "ORG_OWNER"],
    schema: lostSchema,
    requires: [],
    sideEffects: ["OPEN_CLAIM"],
    description: "No update for 7 days or courier declared the parcel lost",
  },
  {
    id: "CASH_COLLECTED",
    from: ["LIVRE"],
    to: ["ENCAISSE"],
    actors: SUPERVISOR_ACTORS,
    schema: cashedSchema,
    requires: [],
    sideEffects: ["INVOICE_LINE"],
    description: "Reconciled against the courier payout",
  },
];

// ─────────────────────────────── lookups ───────────────────────────────

export function findRules(from: OrderStatus, to: OrderStatus): TransitionRule[] {
  return TRANSITIONS.filter((r) => r.from.includes(from) && r.to.includes(to));
}

export function isTransitionDefined(from: OrderStatus, to: OrderStatus): boolean {
  return findRules(from, to).length > 0;
}

export function ruleAllowsActor(rule: TransitionRule, actor: TransitionActor): boolean {
  if (rule.actors.includes(actor)) return true;
  // Platform admins may do anything a human role may do, but never impersonate the system.
  if (actor === "PLATFORM_ADMIN") return rule.actors.some((a) => a !== "SYSTEM");
  return false;
}

export function findRuleForActor(from: OrderStatus, to: OrderStatus, actor: TransitionActor): TransitionRule | undefined {
  return findRules(from, to).find((r) => ruleAllowsActor(r, actor));
}

/** Target statuses an actor may move to from `from` (used by the UI to build the action menu). */
export function allowedTargets(from: OrderStatus, actor: TransitionActor): Array<{ to: OrderStatus; rule: TransitionRule }> {
  const out: Array<{ to: OrderStatus; rule: TransitionRule }> = [];
  for (const rule of TRANSITIONS) {
    if (!rule.from.includes(from) || !ruleAllowsActor(rule, actor)) continue;
    for (const to of rule.to) {
      if (!out.some((o) => o.to === to)) out.push({ to, rule });
    }
  }
  return out;
}

/** APPEL_n derived from the total attempt count (3 attempts per day). */
/** Rule ids an agent uses from the call screen (the UI shows only these as buttons). */
export const AGENT_DECISION_RULES = ["CONFIRM", "CONFIRM_OUT_OF_STOCK", "CONFIRM_POSTPONED", "CANCEL", "POSTPONE", "TO_VERIFY"] as const;

export function nextAttemptStatus(attemptCount: number): OrderStatus {
  const n = attemptCount + 1;
  const withinDay = ((n - 1) % 3) + 1;
  return `APPEL_${withinDay}` as OrderStatus;
}

export function attemptDayOf(attemptNo: number): number {
  return Math.ceil(attemptNo / 3);
}
