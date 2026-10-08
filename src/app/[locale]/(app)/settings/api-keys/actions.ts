"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentContext } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit";
import { API_SCOPES, generateApiKey } from "@/lib/api/keys";
import { hasRole } from "@/lib/tenant";

const createSchema = z.object({
  name: z.string().min(2).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
});

export type CreateKeyResult = { ok: true; keyId: string; secret: string; token: string } | { ok: false; message: string };

export async function createApiKeyAction(input: { name: string; scopes: string[] }): Promise<CreateKeyResult> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER"])) return { ok: false, message: "Forbidden" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Name (2+ chars) and at least one scope are required" };
  const { keyId, secret, secretHash } = generateApiKey();
  await prisma.apiKey.create({ data: { orgId: ctx.orgId, name: parsed.data.name, keyId, secretHash, scopes: parsed.data.scopes, createdById: ctx.userId } });
  await writeAuditLog(ctx, { action: "API_KEY_CREATED", targetType: "ApiKey", targetId: keyId, payload: { name: parsed.data.name, scopes: parsed.data.scopes } });
  revalidatePath(`/${ctx.locale}/settings/api-keys`);
  return { ok: true, keyId, secret, token: `${keyId}.${secret}` };
}

export async function revokeApiKeyAction(keyId: string): Promise<{ ok: boolean }> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER"])) return { ok: false };
  const r = await prisma.apiKey.updateMany({ where: { keyId, orgId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (r.count > 0) await writeAuditLog(ctx, { action: "API_KEY_REVOKED", targetType: "ApiKey", targetId: keyId });
  revalidatePath(`/${ctx.locale}/settings/api-keys`);
  return { ok: r.count > 0 };
}
