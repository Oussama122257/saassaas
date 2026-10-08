import type { NextResponse } from "next/server";
import { Prisma, prisma } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { ApiError } from "./errors";

/**
 * Idempotency-Key handling (section 19b.6): required on POST/PATCH/DELETE, stored 24 h.
 *  - replay with the same body → stored response + `Idempotency-Replay: 1`
 *  - same key, different body → 422 idempotency_key_reuse
 *  - 4xx responses are cached, 5xx never are
 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_REPLAY_HEADER = "Idempotency-Replay";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function needsIdempotencyKey(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}

export function requestHash(method: string, path: string, body: string): string {
  return sha256Hex(`${method.toUpperCase()}\n${path}\n${body}`);
}

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

export async function findIdempotentResponse(
  orgId: string,
  key: string,
  hash: string,
  now = new Date(),
): Promise<StoredResponse | null> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { orgId_key: { orgId, key } } });
  if (!existing) return null;
  if (existing.expiresAt.getTime() <= now.getTime()) {
    await prisma.idempotencyKey.delete({ where: { orgId_key: { orgId, key } } }).catch(() => undefined);
    return null;
  }
  if (existing.requestHash !== hash) {
    throw new ApiError(422, "idempotency_key_reuse", "Idempotency-Key was already used with a different request body");
  }
  return { statusCode: existing.statusCode, body: existing.responseBody };
}

export async function storeIdempotentResponse(params: {
  orgId: string;
  key: string;
  method: string;
  path: string;
  hash: string;
  statusCode: number;
  body: unknown;
  now?: Date;
}): Promise<void> {
  if (params.statusCode >= 500) return; // never cache server errors
  const now = params.now ?? new Date();
  try {
    await prisma.idempotencyKey.create({
      data: {
        orgId: params.orgId,
        key: params.key,
        method: params.method.toUpperCase(),
        path: params.path,
        requestHash: params.hash,
        statusCode: params.statusCode,
        responseBody: params.body as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
    });
  } catch (err) {
    // Concurrent duplicate: the first writer wins; the stored response is what both callers see.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
}

/** Validate the header value: 1..255 printable characters. */
export function readIdempotencyKey(req: Request): string | null {
  const v = req.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!v) return null;
  if (v.length > 255 || !/^[\x21-\x7E]+$/.test(v)) {
    throw ApiError.validation({ header: IDEMPOTENCY_HEADER }, "Idempotency-Key must be 1-255 printable ASCII characters");
  }
  return v;
}

export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const r = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now }, orgId: { not: "" } } });
  return r.count;
}

export type { NextResponse };
