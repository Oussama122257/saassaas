import { z } from "zod";
import type { OrderStatus, Role } from "@prisma/client";
import { CONFIRMATION_OPEN_STATUSES, IN_TRANSIT_STATUSES } from "./statuses";

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
  | "OPEN_CLAIM";

export type Requirement =
  | { kind: "ANSWERED_CALL"; minDurationSec?: number }
  | { kind: "ANY_LOGGED_CALL" }
  | { kind: "ATTEMPT_COUNT_EQUALS"; value: number }
  | { kind: "ATTEMPT_COUNT_LT"; value: number }
  | { kind: "NEXT_ATTEMPT_STATUS" }
  | { kind: "STOCK_ZERO" }
  | { kind: "NOT_FLAGGED"; flag: string }
  | { kind: "NOTE_IF_OTHER" }
  | { kind: "POSTPONE_MAX_DAYS"; days: number };

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
const CANCEL_REASONS = [
  "CHANGED_MIND",
  "PRICE_TOO_HIGH",
  "SHIPPING_FEE",
  "BOUGHT_ELSEWHERE",
  "PRODUCT_DOUBT",
  "WRONG_PRODUCT_OR_SIZE",
  "DELIVERY_TOO_SLOW",
  "DID_NOT_ORDER",
  "OTHER",
] as const;
const RETURN_REASONS = [
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

export const confirmSchema = z.object({
  checklist: z.object({
    productExplained: z.literal(true),
    totalStated: z.literal(true),
    addressVerified: z.literal(true),
    variantVerified: z.literal(true),
    explicitYes: z.literal(true),
  }),
  note: z.string().max(2000).optional(),
});

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
    actors: AGENT_ACTORS,
    schema: callSchema,
    requires: [{ kind: "ATTEMPT_COUNT_LT", value: 9 }, { kind: "NEXT_ATTEMPT_STATUS" }],
    sideEffects: ["SCHEDULE_NEXT_ATTEMPT"],
    description: "Agent logs a call attempt (proof required); APPEL_n is the attempt number within the day",
  },
  {
    id: "CONFIRM",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["CONFIRMEE"],
    actors: AGENT_ACTORS,
    schema: confirmSchema,
    requires: [{ kind: "ANSWERED_CALL" }],
    sideEffects: ["SEND_WRITTEN_CONFIRMATION", "RESERVE_STOCK", "HANDOFF_TO_FOLLOWUP"],
    description: "Confirmation checklist complete and at least one answered call",
  },
  {
    id: "CONFIRM_OUT_OF_STOCK",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["CONFIRMEE_RUPTURE"],
    actors: AGENT_ACTORS,
    schema: confirmSchema,
    requires: [{ kind: "ANSWERED_CALL" }, { kind: "STOCK_ZERO" }],
    sideEffects: ["WAITING_STOCK_TASK", "NOTIFY_SUPERVISOR"],
    description: "Customer confirmed but stock is 0",
  },
  {
    id: "CONFIRM_BOT",
    from: ["ASSIGNEE", "APPEL_1", "APPEL_2", "APPEL_3"],
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
    requires: [{ kind: "ANSWERED_CALL" }, { kind: "NOTE_IF_OTHER" }],
    sideEffects: ["QA_SAMPLE_POOL", "RELEASE_STOCK"],
    description: "Customer cancelled on the phone (reason required)",
  },
  {
    id: "POSTPONE",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["REPORTE"],
    actors: AGENT_ACTORS,
    schema: postponeSchema,
    requires: [{ kind: "POSTPONE_MAX_DAYS", days: 7 }],
    sideEffects: ["SET_NEXT_ACTION"],
    description: "Customer asked to be called back on a later date (max 7 days)",
  },
  {
    id: "TO_VERIFY",
    from: CONFIRMATION_OPEN_STATUSES,
    to: ["A_VERIFIER"],
    actors: AGENT_ACTORS,
    schema: verifySchema,
    requires: [],
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
    requires: [{ kind: "ANY_LOGGED_CALL" }],
    sideEffects: ["RELEASE_STOCK"],
    description: "Agent proposed (flag FAKE_PROPOSED), supervisor finalizes; optional blacklist request",
  },
  {
    id: "UNREACHABLE",
    from: ["APPEL_3"],
    to: ["INJOIGNABLE"],
    actors: SYSTEM_ONLY,
    schema: emptySchema,
    requires: [{ kind: "ATTEMPT_COUNT_EQUALS", value: 9 }],
    sideEffects: ["FINAL_UNREACHABLE_MESSAGE", "RELEASE_STOCK"],
    description: "Scheduler only, after 9 logged attempts over 3 days",
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
export function nextAttemptStatus(attemptCount: number): OrderStatus {
  const n = attemptCount + 1;
  const withinDay = ((n - 1) % 3) + 1;
  return `APPEL_${withinDay}` as OrderStatus;
}

export function attemptDayOf(attemptNo: number): number {
  return Math.ceil(attemptNo / 3);
}
