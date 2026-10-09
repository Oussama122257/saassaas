"use server";

import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createDeviceToken } from "@/lib/devices/tokens";
import { writeAuditLog } from "@/lib/audit";

export async function pairDeviceAction(input: { name: string }): Promise<{ ok: true; token: string; config: string } | { ok: false; message: string }> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, message: "Not signed in" };
  const token = await createDeviceToken(ctx.userId, ctx.orgId, input.name);
  await writeAuditLog(ctx, { action: "API_KEY_CREATED", targetType: "DeviceToken", payload: { name: input.name } });
  revalidatePath(`/${ctx.locale}/devices`);
  const config = JSON.stringify({ apiBase: `${process.env.APP_URL ?? ""}/api/v1`, deviceToken: token, deepLinkScheme: "codcc" });
  return { ok: true, token, config };
}

export async function revokeDeviceAction(input: { id: string }): Promise<{ ok: boolean }> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false };
  const d = await prisma.deviceToken.findFirst({ where: { id: input.id, orgId: ctx.orgId, ...(["ORG_OWNER", "SUPERVISOR"].includes(ctx.role) ? {} : { userId: ctx.userId }) } });
  if (!d) return { ok: false };
  await prisma.deviceToken.update({ where: { id: d.id, orgId: ctx.orgId }, data: { revokedAt: new Date() } });
  await writeAuditLog(ctx, { action: "API_KEY_REVOKED", targetType: "DeviceToken", targetId: d.id });
  revalidatePath(`/${ctx.locale}/devices`);
  return { ok: true };
}
