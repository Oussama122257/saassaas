import { randomBytes } from "node:crypto";
import { prisma, withSystemContext } from "@/lib/db";
import { safeEqual, sha256Hex } from "@/lib/crypto";
import { ApiError } from "./errors";

/**
 * API keys: `Authorization: Bearer <key_id>.<key_secret>`; the secret is shown once at creation,
 * only its SHA-256 is stored.
 */
export const API_SCOPES = [
  "orders:read",
  "orders:write",
  "customers:read",
  "products:read",
  "products:write",
  "shipping:read",
  "shipping:write",
  "webhooks:read",
  "webhooks:write",
  "reports:read",
  "usage:read",
  "messages:send",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyContext {
  kind: "apiKey";
  apiKeyId: string;
  keyId: string;
  orgId: string;
  orgType: "AGENCY" | "MERCHANT";
  scopes: string[];
  /** merchants whose data the key may read (own org for merchants, contracted merchants for agencies) */
  accessibleMerchantIds: string[];
}

export function generateApiKey(): { keyId: string; secret: string; secretHash: string } {
  const keyId = `ck_${randomBytes(9).toString("base64url")}`;
  const secret = randomBytes(32).toString("base64url");
  return { keyId, secret, secretHash: sha256Hex(secret) };
}

export function scopeMatches(granted: string, required: string): boolean {
  if (granted === "*" || granted === required) return true;
  const [gRes, gAct] = granted.split(":");
  const [rRes] = required.split(":");
  return gRes === rRes && gAct === "*";
}

export function hasScope(ctx: ApiKeyContext, required: string): boolean {
  return ctx.scopes.some((g) => scopeMatches(g, required));
}

export function requireScope(ctx: ApiKeyContext, required: string): void {
  if (!hasScope(ctx, required)) throw ApiError.insufficientScope(required);
}

export function parseAuthorization(header: string | null): { keyId: string; secret: string } | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+([^.\s]+)\.([^.\s]+)$/i);
  if (!m || !m[1] || !m[2]) return null;
  return { keyId: m[1], secret: m[2] };
}

export async function authenticateApiKey(header: string | null): Promise<ApiKeyContext> {
  const parsed = parseAuthorization(header);
  if (!parsed) throw ApiError.unauthorized();
  // The key lookup happens before the tenant is known: it is the one query that cannot be scoped.
  const record = await withSystemContext("api-key-auth", () =>
    prisma.apiKey.findUnique({
      where: { keyId: parsed.keyId },
      include: { org: { select: { id: true, type: true, active: true } } },
    }),
  );
  if (!record || record.revokedAt || !record.org.active) throw ApiError.unauthorized();
  if (!safeEqual(record.secretHash, sha256Hex(parsed.secret))) throw ApiError.unauthorized();

  let accessibleMerchantIds: string[];
  if (record.org.type === "MERCHANT") {
    accessibleMerchantIds = [record.org.id];
  } else {
    const contracts = await prisma.serviceContract.findMany({
      where: { agencyId: record.org.id, status: { in: ["TRIAL", "ACTIVE"] } },
      select: { merchantId: true },
    });
    accessibleMerchantIds = contracts.map((c) => c.merchantId);
  }

  // Fire-and-forget usage stamp; never block the request on it.
  void prisma.apiKey.update({ where: { keyId: record.keyId, orgId: record.orgId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return {
    kind: "apiKey",
    apiKeyId: record.id,
    keyId: record.keyId,
    orgId: record.orgId,
    orgType: record.org.type,
    scopes: record.scopes,
    accessibleMerchantIds,
  };
}
