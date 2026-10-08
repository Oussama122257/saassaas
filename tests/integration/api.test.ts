import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api/handler";
import { resetRateLimitMemory } from "@/lib/api/rateLimit";
import { assignOrder } from "@/lib/orders/orderTransitions";
import { createWorld, newOrder, SYSTEM, type World } from "./fixtures";

let w: World;
const ids: string[] = [];

beforeAll(async () => {
  w = await createWorld();
  for (let i = 0; i < 7; i++) {
    const o = await newOrder(w, i % 2 === 0 ? "A" : "B", { createdAt: new Date(Date.now() - i * 60_000) });
    ids.push(o.id);
  }
  await assignOrder(SYSTEM, { orderId: ids[0]!, toUserId: w.users.agentA1.id });
  await newOrder(w, "S");
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /v1/ping and /v1/whoami", () => {
  it("ping is public and returns the envelope", async () => {
    const { GET } = await import("@/app/api/v1/ping/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/ping", { headers: { "X-Request-Id": "req-1" } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("req-1");
    const body = await res.json();
    expect(body.data.pong).toBe(true);
    expect(body.meta.request_id).toBe("req-1");
  });
  it("whoami needs a key and describes the org, scopes and accessible merchants", async () => {
    const { GET } = await import("@/app/api/v1/whoami/route");
    const anon = await GET(new NextRequest("http://localhost/api/v1/whoami"), { params: Promise.resolve({}) });
    expect(anon.status).toBe(401);
    expect((await anon.json()).error.code).toBe("unauthorized");
    const res = await GET(new NextRequest("http://localhost/api/v1/whoami", { headers: auth(w.apiKeys.agency) }), { params: Promise.resolve({}) });
    const body = await res.json();
    expect(body.data.org.id).toBe(w.agency.id);
    expect(body.data.key.scopes).toEqual(["orders:read", "orders:write"]);
    expect(body.data.accessible_merchants.map((m: { id: string }) => m.id).sort()).toEqual([w.merchantA.id, w.merchantB.id].sort());
  });
});

describe("GET /v1/orders", () => {
  async function list(qs: string, token = w.apiKeys.agency) {
    const { GET } = await import("@/app/api/v1/orders/route");
    const res = await GET(new NextRequest(`http://localhost/api/v1/orders${qs}`, { headers: auth(token) }), { params: Promise.resolve({}) });
    return { status: res.status, body: await res.json() };
  }
  it("paginates with cursors and never leaks other merchants", async () => {
    const p1 = await list("?limit=3");
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(3);
    expect(p1.body.meta.next_cursor).toBeTruthy();
    const p2 = await list(`?limit=3&cursor=${p1.body.meta.next_cursor}`);
    const p3 = await list(`?limit=3&cursor=${p2.body.meta.next_cursor}`);
    const all = [...p1.body.data, ...p2.body.data, ...p3.body.data];
    expect(all).toHaveLength(7);
    expect(new Set(all.map((o: { id: string }) => o.id)).size).toBe(7);
    expect(p3.body.meta.next_cursor).toBeNull();
    for (const o of all) expect([w.merchantA.id, w.merchantB.id]).toContain(o.merchant_id);
    const mb = await list("", w.apiKeys.merchantB);
    expect(mb.body.data.every((o: { merchant_id: string }) => o.merchant_id === w.merchantB.id)).toBe(true);
    expect(mb.body.data).toHaveLength(3);
  });
  it("filters by status and validates input", async () => {
    const assigned = await list("?status=ASSIGNEE");
    expect(assigned.body.data.map((o: { id: string }) => o.id)).toEqual([ids[0]]);
    expect((await list("?status=NOPE")).status).toBe(400);
    expect((await list("?limit=999")).status).toBe(400);
    expect((await list("?cursor=garbage")).body.error.code).toBe("validation_error");
  });
  it("enforces scopes", async () => {
    const res = await list("", w.apiKeys.saas);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("insufficient_scope");
  });
  it("serializes the documented shape", async () => {
    const res = await list("?limit=1");
    const o = res.body.data[0];
    expect(o).toMatchObject({ amounts: { currency: "DZD" }, status_group: "CONFIRMATION" });
    expect(o.customer.phone).toMatch(/^0[567]\d{8}$/);
    expect(o.items[0]).toHaveProperty("product_name");
  });
});

describe("rate limiting and idempotency (handler wrapper)", () => {
  it("returns 429 with retry_after after the per-org budget", async () => {
    resetRateLimitMemory();
    const handler = apiHandler({ rateLimit: 2 }, async () => ({ data: { ok: true } }));
    const mk = () => handler(new NextRequest("http://localhost/api/v1/test", { headers: auth(w.apiKeys.merchantB) }), { params: Promise.resolve({}) });
    const [a, b, c] = [await mk(), await mk(), await mk()];
    expect([a.status, b.status, c.status]).toEqual([200, 200, 429]);
    expect(c.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect((await c.json()).error).toMatchObject({ code: "rate_limited" });
  });

  it("requires Idempotency-Key on POST, replays identical requests and rejects reuse with a different body", async () => {
    let calls = 0;
    const handler = apiHandler({}, async ({ json }) => {
      calls++;
      const body = json<{ fail?: boolean; n: number }>();
      if (body.fail) throw new Error("boom");
      return { status: 201, data: { created: body.n, call: calls } };
    });
    const post = (body: unknown, key?: string) =>
      handler(
        new NextRequest("http://localhost/api/v1/test", { method: "POST", body: JSON.stringify(body), headers: { ...auth(w.apiKeys.agency), "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) } }),
        { params: Promise.resolve({}) },
      );
    const missing = await post({ n: 1 });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe("idempotency_key_required");

    const first = await post({ n: 1 }, "idem-1");
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotency-Replay")).toBeNull();
    const replay = await post({ n: 1 }, "idem-1");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replay")).toBe("1");
    expect((await replay.json()).data).toEqual({ created: 1, call: 1 });
    expect(calls).toBe(1);

    const reuse = await post({ n: 2 }, "idem-1");
    expect(reuse.status).toBe(422);
    expect((await reuse.json()).error.code).toBe("idempotency_key_reuse");

    // 5xx are never cached: a retry with the same key runs the handler again
    const failed = await post({ n: 3, fail: true }, "idem-2");
    expect(failed.status).toBe(500);
    const retried = await post({ n: 3, fail: true }, "idem-2");
    expect(retried.status).toBe(500);
    expect(retried.headers.get("Idempotency-Replay")).toBeNull();
    expect(calls).toBe(3); // first + two uncached failures; the replay and the 422 never ran the handler

    // keys are per org: another org may reuse the same key string
    const other = await handler(
      new NextRequest("http://localhost/api/v1/test", { method: "POST", body: JSON.stringify({ n: 9 }), headers: { ...auth(w.apiKeys.merchantB), "Idempotency-Key": "idem-1" } }),
      { params: Promise.resolve({}) },
    );
    expect(other.status).toBe(201);
  });
});
