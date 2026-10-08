import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma, TenantGuardError, withSystemContext } from "@/lib/db";
import { assignOrder, transitionOrder, TransitionError } from "@/lib/orders/orderTransitions";
import { getOrderDetail, listOrders, queueChips } from "@/lib/orders/repository";
import { createWorld, newOrder, SYSTEM, type World } from "./fixtures";

let w: World;
let orderA: Awaited<ReturnType<typeof newOrder>>;
let orderA2: Awaited<ReturnType<typeof newOrder>>;
let orderB: Awaited<ReturnType<typeof newOrder>>;
let orderS: Awaited<ReturnType<typeof newOrder>>;

beforeAll(async () => {
  w = await createWorld();
  orderA = await newOrder(w, "A");
  orderA2 = await newOrder(w, "A");
  orderB = await newOrder(w, "B");
  orderS = await newOrder(w, "S");
  await assignOrder(SYSTEM, { orderId: orderA.id, toUserId: w.users.agentA1.id });
  await assignOrder(SYSTEM, { orderId: orderA2.id, toUserId: w.users.agentA2.id });
  await assignOrder(SYSTEM, { orderId: orderB.id, toUserId: w.users.agentB1.id });
});

describe("tenant isolation — organizations", () => {
  it("an agency sees only the merchants it has an active contract with", async () => {
    expect(w.ctx.supervisor.accessibleMerchantIds.sort()).toEqual([w.merchantA.id, w.merchantB.id].sort());
    const { rows } = await listOrders(w.ctx.supervisor, {});
    expect(rows.map((r) => r.id).sort()).toEqual([orderA.id, orderA2.id, orderB.id].sort());
    expect(rows.find((r) => r.id === orderS.id)).toBeUndefined();
  });

  it("an agency without a contract sees nothing", async () => {
    expect(w.ctx.otherSupervisor.accessibleMerchantIds).toEqual([]);
    const { rows, total } = await listOrders(w.ctx.otherSupervisor, {});
    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(await getOrderDetail(w.ctx.otherSupervisor, orderA.id)).toBeNull();
    await expect(transitionOrder(w.ctx.otherSupervisor, { orderId: orderA.id, to: "A_VERIFIER", payload: { comment: "hack" } })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("a merchant sees only its own orders (client viewer and SaaS owner)", async () => {
    const a = await listOrders(w.ctx.clientA, {});
    expect(a.rows.map((r) => r.merchantId)).toEqual([w.merchantA.id, w.merchantA.id]);
    expect(await getOrderDetail(w.ctx.clientA, orderB.id)).toBeNull();
    expect(await getOrderDetail(w.ctx.clientA, orderA.id)).not.toBeNull();
    const s = await listOrders(w.ctx.saasOwner, {});
    expect(s.rows.map((r) => r.id)).toEqual([orderS.id]);
    const chips = await queueChips(w.ctx.saasOwner);
    expect(chips.total).toBe(1);
  });

  it("filters cannot widen the scope (merchantId filter outside the contract is ignored by the AND)", async () => {
    const { rows } = await listOrders(w.ctx.clientA, { merchantId: w.merchantB.id });
    expect(rows).toEqual([]);
  });
});

describe("tenant isolation — agents", () => {
  it("a confirmation agent sees only orders assigned to them", async () => {
    const a1 = await listOrders(w.ctx.agentA1, {});
    expect(a1.rows.map((r) => r.id)).toEqual([orderA.id]);
    expect(await getOrderDetail(w.ctx.agentA1, orderA2.id)).toBeNull();
    expect(await getOrderDetail(w.ctx.agentA1, orderB.id)).toBeNull();
  });

  it("an agent cannot act on a colleague's order", async () => {
    await expect(transitionOrder(w.ctx.agentA1, { orderId: orderA2.id, to: "A_VERIFIER", payload: { comment: "not mine" } })).rejects.toMatchObject({ code: "NOT_ORDER_OWNER" });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: orderB.id, to: "A_VERIFIER", payload: { comment: "not mine" } })).rejects.toMatchObject({ code: "NOT_ORDER_OWNER" });
  });

  it("a follow-up agent sees their pod's orders only from the confirmation decision onward", async () => {
    const before = await listOrders(w.ctx.followupA, {});
    expect(before.rows).toEqual([]);
    await withSystemContext("test", () =>
      prisma.callAttempt.create({ data: { orderId: orderA.id, agentId: w.users.agentA1.id, attemptNo: 1, day: 1, slot: "MORNING", startedAt: new Date(), durationSec: 60, outcome: "ANSWERED", proof: "DEVICE_LOG" } }),
    );
    await transitionOrder(w.ctx.agentA1, { orderId: orderA.id, to: "APPEL_1", payload: { call: { outcome: "ANSWERED", proof: "DEVICE_LOG", durationSec: 40 } } });
    await transitionOrder(w.ctx.agentA1, { orderId: orderA.id, to: "CONFIRMEE", payload: { checklist: { productExplained: true, totalStated: true, addressVerified: true, variantVerified: true, explicitYes: true } } });
    const after = await listOrders(w.ctx.followupA, {});
    expect(after.rows.map((r) => r.id)).toEqual([orderA.id]);
    const b = await listOrders(w.ctx.followupB, {});
    expect(b.rows).toEqual([]);
  });
});

describe("tenant isolation — API keys", () => {
  async function get(path: string, token?: string) {
    const { GET } = await import("@/app/api/v1/orders/[id]/route");
    const req = new NextRequest(`http://localhost${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const id = path.split("/").pop()!;
    return GET(req, { params: Promise.resolve({ id }) });
  }
  it("a merchant key cannot read another merchant's order; an agency key reads its contracted merchants", async () => {
    expect((await get(`/api/v1/orders/${orderA.id}`, w.apiKeys.merchantB)).status).toBe(404);
    expect((await get(`/api/v1/orders/${orderB.id}`, w.apiKeys.merchantB)).status).toBe(200);
    expect((await get(`/api/v1/orders/${orderA.id}`, w.apiKeys.agency)).status).toBe(200);
    expect((await get(`/api/v1/orders/${orderS.id}`, w.apiKeys.agency)).status).toBe(404);
    expect((await get(`/api/v1/orders/${orderA.id}`)).status).toBe(401);
    expect((await get(`/api/v1/orders/${orderA.id}`, "ck_test_agency.wrong")).status).toBe(401);
    expect((await get(`/api/v1/orders/${orderS.id}`, w.apiKeys.saas)).status).toBe(403); // scope products:read only
  });
});

describe("tenant guard (Prisma extension)", () => {
  it("throws on unscoped queries and allows system jobs", async () => {
    await expect(prisma.order.findMany({})).rejects.toBeInstanceOf(TenantGuardError);
    await expect(prisma.order.findUnique({ where: { id: orderA.id } })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(prisma.orderEvent.count({ where: { type: "NOTE" } })).rejects.toBeInstanceOf(TenantGuardError);
    const n = await prisma.order.count({ where: { merchantId: { in: [w.merchantA.id] } } });
    expect(n).toBe(2);
    const all = await withSystemContext("test", () => prisma.order.count());
    expect(all).toBe(4);
  });
  it("TransitionError is thrown (not a guard error) for cross-tenant writes", async () => {
    await expect(transitionOrder(w.ctx.saasOwner, { orderId: orderA.id, to: "A_VERIFIER", payload: { comment: "x" } })).rejects.toBeInstanceOf(TransitionError);
  });
});
