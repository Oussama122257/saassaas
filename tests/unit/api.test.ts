import { describe, expect, it, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { API_VERSION, fail, ok, resolveRequestId } from "@/lib/api/envelope";
import { ApiError } from "@/lib/api/errors";
import { parseAuthorization, scopeMatches, hasScope, generateApiKey, type ApiKeyContext } from "@/lib/api/keys";
import { needsIdempotencyKey, readIdempotencyKey, requestHash } from "@/lib/api/idempotency";
import { cursorWhere, decodeCursor, encodeCursor, page, parseLimit } from "@/lib/api/pagination";
import { checkRateLimit, resetRateLimitMemory } from "@/lib/api/rateLimit";

describe("envelope", () => {
  it("wraps data and echoes a safe client request id", async () => {
    const req = new NextRequest("http://x/api/v1/ping", { headers: { "X-Request-Id": "client-123" } });
    const id = resolveRequestId(req);
    expect(id).toBe("client-123");
    const res = ok({ a: 1 }, id, { meta: { next_cursor: null } });
    expect(res.headers.get("X-Request-Id")).toBe("client-123");
    expect(res.headers.get("X-Api-Version")).toBe(API_VERSION);
    expect(await res.json()).toEqual({ data: { a: 1 }, meta: { request_id: "client-123", api_version: API_VERSION, next_cursor: null } });
  });
  it("mints an id when the client one is unsafe", () => {
    const req = new NextRequest("http://x/api/v1/ping", { headers: { "X-Request-Id": "bad id with spaces" } });
    expect(resolveRequestId(req)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("formats errors with stable codes and retry_after", async () => {
    const res = fail(ApiError.rateLimited(17), "rid");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests", retry_after: 17 }, meta: { request_id: "rid", api_version: API_VERSION } });
  });
});

describe("api keys", () => {
  it("parses Authorization: Bearer key_id.secret", () => {
    expect(parseAuthorization("Bearer ck_abc.s3cret")).toEqual({ keyId: "ck_abc", secret: "s3cret" });
    expect(parseAuthorization("bearer ck_abc.s3cret")).toEqual({ keyId: "ck_abc", secret: "s3cret" });
    expect(parseAuthorization("Bearer nodot")).toBeNull();
    expect(parseAuthorization("Basic xx")).toBeNull();
    expect(parseAuthorization(null)).toBeNull();
  });
  it("matches scopes with wildcards", () => {
    expect(scopeMatches("orders:read", "orders:read")).toBe(true);
    expect(scopeMatches("orders:*", "orders:write")).toBe(true);
    expect(scopeMatches("*", "webhooks:write")).toBe(true);
    expect(scopeMatches("orders:read", "orders:write")).toBe(false);
    expect(scopeMatches("products:*", "orders:read")).toBe(false);
    const ctx: ApiKeyContext = { kind: "apiKey", apiKeyId: "1", keyId: "k", orgId: "o", orgType: "MERCHANT", scopes: ["orders:read"], accessibleMerchantIds: ["o"] };
    expect(hasScope(ctx, "orders:read")).toBe(true);
    expect(hasScope(ctx, "orders:write")).toBe(false);
  });
  it("generates keys with a hashed secret", () => {
    const k = generateApiKey();
    expect(k.keyId).toMatch(/^ck_[A-Za-z0-9_-]{12}$/);
    expect(k.secret.length).toBeGreaterThanOrEqual(40);
    expect(k.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotency helpers", () => {
  it("requires keys on mutating methods only", () => {
    expect(needsIdempotencyKey("POST")).toBe(true);
    expect(needsIdempotencyKey("patch")).toBe(true);
    expect(needsIdempotencyKey("DELETE")).toBe(true);
    expect(needsIdempotencyKey("GET")).toBe(false);
  });
  it("hashes method + path + body", () => {
    expect(requestHash("POST", "/v1/orders", "{}")).toBe(requestHash("post", "/v1/orders", "{}"));
    expect(requestHash("POST", "/v1/orders", "{}")).not.toBe(requestHash("POST", "/v1/orders", '{"a":1}'));
  });
  it("validates the header value", () => {
    expect(readIdempotencyKey(new NextRequest("http://x/", { headers: { "Idempotency-Key": "abc-123" } }))).toBe("abc-123");
    expect(readIdempotencyKey(new NextRequest("http://x/"))).toBeNull();
    expect(() => readIdempotencyKey(new NextRequest("http://x/", { headers: { "Idempotency-Key": "x".repeat(300) } }))).toThrow(ApiError);
  });
});

describe("cursor pagination", () => {
  it("round-trips cursors and rejects bad ones", () => {
    const c = { createdAt: "2026-10-01T10:00:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(null)).toBeNull();
    expect(() => decodeCursor("not-base64-json")).toThrow(ApiError);
    expect(() => decodeCursor(Buffer.from('{"createdAt":"nope","id":"x"}').toString("base64url"))).toThrow(ApiError);
  });
  it("parses limit within 1..200", () => {
    expect(parseLimit(null)).toBe(50);
    expect(parseLimit("200")).toBe(200);
    expect(() => parseLimit("201")).toThrow(ApiError);
    expect(() => parseLimit("0")).toThrow(ApiError);
    expect(() => parseLimit("abc")).toThrow(ApiError);
  });
  it("builds the keyset where clause and trims limit+1 pages", () => {
    const at = new Date("2026-10-01T10:00:00.000Z");
    expect(cursorWhere({ createdAt: at.toISOString(), id: "b" })).toEqual({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: "b" } }] });
    const rows = [1, 2, 3].map((i) => ({ id: `r${i}`, createdAt: new Date(2026, 9, i) }));
    const p = page(rows, 2);
    expect(p.items.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(decodeCursor(p.nextCursor)).toEqual({ createdAt: rows[1]!.createdAt.toISOString(), id: "r2" });
    expect(page(rows, 3).nextCursor).toBeNull();
  });
});

describe("rate limiter (memory backend)", () => {
  beforeEach(() => resetRateLimitMemory());
  it("allows `limit` requests per minute per org then returns retry_after", async () => {
    const now = Date.parse("2026-10-08T10:00:30.000Z");
    const r1 = await checkRateLimit("org1", 2, now);
    const r2 = await checkRateLimit("org1", 2, now + 1000);
    const r3 = await checkRateLimit("org1", 2, now + 2000);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, false]);
    expect(r3.retryAfter).toBe(28);
    expect((await checkRateLimit("org2", 2, now)).allowed).toBe(true);
    expect((await checkRateLimit("org1", 2, now + 60_000)).allowed).toBe(true);
  });
});
