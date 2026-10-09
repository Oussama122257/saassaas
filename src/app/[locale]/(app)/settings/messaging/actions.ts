"use server";

import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { hasRole } from "@/lib/tenant";
import { isTemplateKey } from "@/lib/messaging/templates";
import { topUpCredits } from "@/lib/messaging/credits";

type Result = { ok: true } | { ok: false; message: string };

export async function saveTemplateAction(input: { merchantId: string; key: string; channel: "WHATSAPP" | "SMS"; lang: "fr" | "ar"; body: string; waTemplateName?: string; waLanguage?: string; active: boolean }): Promise<Result> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) return { ok: false, message: "Forbidden" };
  if (!ctx.accessibleMerchantIds.includes(input.merchantId)) return { ok: false, message: "No access" };
  if (!isTemplateKey(input.key)) return { ok: false, message: "Unknown template" };
  const body = input.body.trim();
  if (!body) {
    await prisma.messageTemplate.deleteMany({ where: { merchantId: input.merchantId, key: input.key, channel: input.channel, lang: input.lang } });
  } else {
    await prisma.messageTemplate.upsert({
      where: { merchantId_key_channel_lang: { merchantId: input.merchantId, key: input.key, channel: input.channel, lang: input.lang } },
      create: { merchantId: input.merchantId, key: input.key, channel: input.channel, lang: input.lang, body: body.slice(0, 1000), waTemplateName: input.waTemplateName || null, waLanguage: input.waLanguage || null, active: input.active },
      update: { body: body.slice(0, 1000), waTemplateName: input.waTemplateName || null, waLanguage: input.waLanguage || null, active: input.active },
    });
  }
  await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "MessageTemplate", payload: { merchantId: input.merchantId, key: input.key, channel: input.channel, lang: input.lang } });
  revalidatePath(`/${ctx.locale}/settings/messaging`);
  return { ok: true };
}

/** Credit top-up (platform admin; receipts / gateway payments arrive with phase 6 billing). */
export async function topUpCreditsAction(input: { orgId: string; amount: number; note?: string }): Promise<Result> {
  const ctx = await getCurrentContext();
  if (!ctx || !ctx.isPlatformAdmin) return { ok: false, message: "Platform admin only" };
  if (!Number.isInteger(input.amount) || input.amount === 0 || Math.abs(input.amount) > 1_000_000) return { ok: false, message: "Invalid amount" };
  await topUpCredits(input.orgId, input.amount, { actorId: ctx.userId, note: input.note, reason: input.amount > 0 ? "TOPUP" : "ADJUSTMENT" });
  await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "MessageCreditLedger", targetId: input.orgId, payload: { amount: input.amount } });
  revalidatePath(`/${ctx.locale}/settings/messaging`);
  return { ok: true };
}
