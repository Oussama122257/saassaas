"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { hasRole } from "@/lib/tenant";
import { deepMerge, orgSettingsSchema } from "@/lib/settings";
import { validateDistribution } from "@/lib/assign/engine";
import { normalizePhone } from "@/lib/phone";

type Result = { ok: true } | { ok: false; message: string };

/** Save part of an org's settings (team org or an accessible merchant). Validated with the settings schema. */
export async function saveOpsSettingsAction(input: { orgId: string; patch: Record<string, unknown> }): Promise<Result> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) return { ok: false, message: "Forbidden" };
  if (input.orgId !== ctx.orgId && !ctx.accessibleMerchantIds.includes(input.orgId)) return { ok: false, message: "No access to this organization" };
  const org = await prisma.organization.findUnique({ where: { id: input.orgId }, select: { settings: true } });
  const merged = deepMerge<Record<string, unknown>>((org?.settings ?? {}) as Record<string, unknown>, input.patch);
  const assignment = (merged.assignment ?? {}) as { strategy?: string; distribution?: { percents: Record<string, number> } | null };
  if (assignment.strategy === "PERCENTAGE") {
    if (!assignment.distribution) return { ok: false, message: "Set a percentage per agent" };
    const v = validateDistribution(assignment.distribution.percents);
    if (!v.ok) return { ok: false, message: `Percentages must total 100 (now ${v.total})` };
  }
  const parsed = orgSettingsSchema.safeParse(merged);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  await prisma.organization.update({ where: { id: input.orgId }, data: { settings: merged as Prisma.InputJsonValue } });
  await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Organization", targetId: input.orgId, payload: { keys: Object.keys(input.patch) } });
  revalidatePath(`/${ctx.locale}/settings/operations`);
  return { ok: true };
}

export async function saveNumberAction(input: { id?: string; label: string; msisdn: string; active: boolean }): Promise<Result> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) return { ok: false, message: "Forbidden" };
  const phone = normalizePhone(input.msisdn);
  if (!phone.valid) return { ok: false, message: "Invalid phone number" };
  const label = input.label.trim().slice(0, 8) || "A";
  if (input.id) {
    const existing = await prisma.outboundNumber.findFirst({ where: { id: input.id, orgId: ctx.orgId } });
    if (!existing) return { ok: false, message: "Not found" };
    await prisma.outboundNumber.update({ where: { id: input.id, orgId: ctx.orgId }, data: { label, msisdn: phone.phone!, active: input.active, ...(input.active && existing.burnedAt ? { burnedAt: null } : {}) } });
  } else {
    await prisma.outboundNumber.create({ data: { orgId: ctx.orgId, label, msisdn: phone.phone!, active: input.active } });
  }
  await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "OutboundNumber", payload: { label, active: input.active } });
  revalidatePath(`/${ctx.locale}/settings/operations`);
  return { ok: true };
}
