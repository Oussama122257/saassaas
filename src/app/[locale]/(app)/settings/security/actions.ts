"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentContext } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/lib/auth/totp";

/** Step 1: generate a secret and store it unconfirmed (totpEnabledAt stays null until verified). */
export async function startTotpEnrollmentAction(): Promise<{ ok: true; secret: string; otpauth: string } | { ok: false; message: string }> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, message: "Not signed in" };
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true, totpEnabledAt: true } });
  if (!user) return { ok: false, message: "User not found" };
  if (user.totpEnabledAt) return { ok: false, message: "2FA already enabled" };
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: ctx.userId }, data: { totpSecret: secret } });
  return { ok: true, secret, otpauth: otpauthUrl({ issuer: "COD Center", account: user.email, secret }) };
}

/** Step 2: the user types the code shown by their app; on success 2FA becomes mandatory at login. */
export async function confirmTotpEnrollmentAction(code: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, message: "Not signed in" };
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { totpSecret: true, totpEnabledAt: true } });
  if (!user?.totpSecret || user.totpEnabledAt) return { ok: false, message: "No pending enrollment" };
  if (!verifyTotp(user.totpSecret, code)) return { ok: false, message: "invalid" };
  await prisma.user.update({ where: { id: ctx.userId }, data: { totpEnabledAt: new Date() } });
  await writeAuditLog(ctx, { action: "TOTP_ENABLED", targetType: "User", targetId: ctx.userId });
  revalidatePath(`/${ctx.locale}/settings/security`);
  return { ok: true };
}

export async function disableTotpAction(code: string): Promise<{ ok: boolean; message?: string }> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, message: "Not signed in" };
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { totpSecret: true, totpEnabledAt: true } });
  if (!user?.totpSecret || !user.totpEnabledAt) return { ok: false, message: "2FA is not enabled" };
  if (!verifyTotp(user.totpSecret, code)) return { ok: false, message: "invalid" };
  await prisma.user.update({ where: { id: ctx.userId }, data: { totpSecret: null, totpEnabledAt: null } });
  await writeAuditLog(ctx, { action: "TOTP_DISABLED", targetType: "User", targetId: ctx.userId });
  revalidatePath(`/${ctx.locale}/settings/security`);
  return { ok: true };
}
