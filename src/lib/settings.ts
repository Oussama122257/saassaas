import { z } from "zod";

/**
 * Organization settings (Organization.settings JSON). Every rule the system enforces reads its
 * thresholds from here, so owners can tune them without a deploy. Defaults follow the spec.
 *
 * Resolution for an order: defaults ← merchant org settings ← team org settings (the org that owns
 * the pod working the order). The team wins for call-engine and assignment rules; the merchant
 * decides intake, risk and write-back rules for their own stores.
 */

/** minutes since midnight, [start, end) */
const windowSchema = z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]);
export type MinuteWindow = z.infer<typeof windowSchema>;

export const callSettingsSchema = z.object({
  /** day 1, attempt 1: within N minutes of the order */
  firstCallWithinMin: z.number().int().min(1).default(15),
  /** planning gap between two attempts (section 8.2, default 2 h) */
  cadenceGapMin: z.number().int().min(1).default(120),
  /** hard minimum spacing; an attempt inside this gap is rejected (section 19c.1, default 30 min) */
  minAttemptGapMin: z.number().int().min(0).default(30),
  /** enforce slot windows for attempts (section 8.2 "slots are locked") */
  strictSlots: z.boolean().default(true),
  slots: z
    .object({ MORNING: windowSchema, AFTERNOON: windowSchema, EVENING: windowSchema })
    .default({ MORNING: [600, 720], AFTERNOON: [840, 960], EVENING: [1080, 1200] }),
  /** no calls before / after (09:00 – 21:00) */
  dayStartMin: z.number().int().default(540),
  dayEndMin: z.number().int().default(1260),
  /** daily prayer windows (org-configurable list) */
  prayerWindows: z.array(windowSchema).default([[765, 795]]),
  /** Friday midday block */
  fridayBlock: windowSchema.nullable().default([720, 870]),
  maxAttemptsPerRound: z.number().int().min(3).default(9),
  /** cap across all rounds (section 19c.1) */
  maxAttemptsTotal: z.number().int().min(3).default(12),
  /** FAUSSE_COMMANDE / EXPIREE / INJOIGNABLE need N properly spaced attempts over ≥ M slots */
  minSpacedAttemptsToClose: z.number().int().min(0).default(3),
  minSlotsToClose: z.number().int().min(1).default(2),
  /** fast retry threshold for the KPI (minutes) */
  fastRetryMin: z.number().int().default(3),
});

export const lifecycleSettingsSchema = z.object({
  lockTimeoutMin: z.number().int().min(1).default(10),
  /** EXPIREE: unconfirmed N days after the last attempt day */
  expiryDays: z.number().int().min(1).default(3),
  recycleCooldownDays: z.number().int().min(0).default(2),
  maxRecycleRounds: z.number().int().min(0).default(1),
  /** NOUVEAU / ASSIGNEE untouched → reassign */
  untouchedReassignMin: z.number().int().min(1).default(30),
  /** CONFIRMEE_REPORTEE: max days ahead */
  confirmedPostponeMaxDays: z.number().int().min(1).default(30),
});

export const assignmentSettingsSchema = z.object({
  strategy: z.enum(["LOAD_BALANCED", "PERCENTAGE"]).default("LOAD_BALANCED"),
  /** PERCENTAGE strategy: userId → percent (must total 100); applies to orders after savedAt */
  distribution: z.object({ savedAt: z.string(), percents: z.record(z.string(), z.number().min(0).max(100)) }).nullable().default(null),
  /** agents cannot act on orders assigned to others (supervisors can) */
  ownershipLock: z.boolean().default(false),
  maxOpenOrdersPerAgent: z.number().int().min(1).default(40),
  /** high-value orders / new products → top-rated agents */
  highValueToTopAgents: z.boolean().default(true),
  topAgentIds: z.array(z.string()).default([]),
  /** wilaya → preferred agent ids */
  wilayaRouting: z.record(z.string(), z.array(z.string())).default({}),
  requireShift: z.boolean().default(true),
});

export const intakeSettingsSchema = z.object({
  ipLimitEnabled: z.boolean().default(true),
  ipLimitMax: z.number().int().min(1).default(3),
  ipLimitHours: z.number().int().min(1).default(12),
  /** refuse blacklisted phones at intake, or accept and flag */
  blacklistMode: z.enum(["FLAG", "REFUSE"]).default("FLAG"),
  algerianPhonesOnly: z.boolean().default(true),
  duplicateWindowHours: z.number().int().min(1).default(48),
});

export const orgSettingsSchema = z.object({
  minAnsweredCallSec: z.number().int().min(0).default(15),
  highValueThreshold: z.number().int().min(0).default(15000),
  /** allow attempts without call proof (flagged in KPIs) */
  manualCallProof: z.boolean().default(false),
  /** require a written note for ANNULEE, FAUSSE_COMMANDE and customer-cancel */
  mandatoryCancelNote: z.boolean().default(false),
  riskyWilayas: z.array(z.number().int()).default([]),
  /** kept for backward compatibility; assignment.maxOpenOrdersPerAgent wins */
  maxOpenOrdersPerAgent: z.number().int().default(40),
  calls: callSettingsSchema.default(callSettingsSchema.parse({})),
  lifecycle: lifecycleSettingsSchema.default(lifecycleSettingsSchema.parse({})),
  assignment: assignmentSettingsSchema.default(assignmentSettingsSchema.parse({})),
  intake: intakeSettingsSchema.default(intakeSettingsSchema.parse({})),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;
export type CallSettings = z.infer<typeof callSettingsSchema>;
export type LifecycleSettings = z.infer<typeof lifecycleSettingsSchema>;
export type AssignmentSettings = z.infer<typeof assignmentSettingsSchema>;
export type IntakeSettings = z.infer<typeof intakeSettingsSchema>;

export const DEFAULT_ORG_SETTINGS: OrgSettings = orgSettingsSchema.parse({});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for plain objects (arrays and scalars are replaced). */
export function deepMerge<T>(base: T, ...overrides: unknown[]): T {
  let out: unknown = base;
  for (const o of overrides) {
    if (!isPlainObject(o)) continue;
    const acc: Record<string, unknown> = { ...(out as Record<string, unknown>) };
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      acc[k] = isPlainObject(v) && isPlainObject(acc[k]) ? deepMerge(acc[k], v) : v;
    }
    out = acc;
  }
  return out as T;
}

/** Parse stored settings leniently: unknown keys are dropped, invalid values fall back to defaults. */
export function parseOrgSettings(...raws: unknown[]): OrgSettings {
  const merged = deepMerge<Record<string, unknown>>({}, ...raws);
  const parsed = orgSettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Drop only the offending leaves (their defaults apply) rather than failing closed.
  const cleaned = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
  for (const issue of parsed.error.issues) {
    let node: unknown = cleaned;
    const path = issue.path.filter((k): k is string | number => typeof k === "string" || typeof k === "number");
    for (let i = 0; i < path.length - 1 && node && typeof node === "object"; i++) node = (node as Record<string | number, unknown>)[path[i]!];
    const leaf = path[path.length - 1];
    if (node && typeof node === "object" && leaf !== undefined) {
      if (Array.isArray(node) && typeof leaf === "number") node.splice(leaf, 1);
      else delete (node as Record<string | number, unknown>)[leaf];
    }
  }
  const retry = orgSettingsSchema.safeParse(cleaned);
  return retry.success ? retry.data : DEFAULT_ORG_SETTINGS;
}
