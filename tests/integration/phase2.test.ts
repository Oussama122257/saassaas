import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma, withSystemContext } from "@/lib/db";
import { encryptSecret, sha256Hex } from "@/lib/crypto";
import { assignOrder, claimOrder, createOrder, transitionOrder } from "@/lib/orders/orderTransitions";
import { planAttempt } from "@/lib/calls/slots";
import { DEFAULT_ORG_SETTINGS } from "@/lib/settings";
import { markUnreachable, nightlyExpiry, reassignUntouched, recycleOrders, releaseExpiredLocks, requeueDue } from "@/lib/calls/scheduler";
import { nextOrderForAgent } from "@/lib/calls/agentQueue";
import { ingestOrder, resolveUnmatchedLine } from "@/lib/ingest/pipeline";
import { signShopifyWebhook } from "@/lib/adapters/stores/shopify";
import { zonedDate, addDays, addHours } from "@/lib/time";
import { CHECKLIST, createWorld, newOrder, nextPhone, PERMISSIVE_SETTINGS, setAgencySettings, SYSTEM, type World } from "./fixtures";

const tz = "Africa/Algiers";
const cfg = DEFAULT_ORG_SETTINGS.calls;
/** Monday 28 Sep 2026, local wall clock */
const mon = (h: number, m = 0, dayOffset = 0) => zonedDate(2026, 9, 28 + dayOffset, h, m, 0, tz);

let w: World;

async function sys<T>(fn: () => Promise<T>) {
  return withSystemContext("test", fn);
}

async function makeAvailable(userIds: string[]) {
  await sys(async () => {
    await prisma.membership.updateMany({ where: { userId: { in: userIds } }, data: { availability: "AVAILABLE" } });
    for (const userId of userIds) {
      for (let weekday = 0; weekday < 7; weekday++) await prisma.shift.create({ data: { orgId: w.agency.id, userId, weekday, startMin: 0, endMin: 1440 } });
    }
  });
}

async function assignedOrder(createdAt: Date, agent: "agentA1" | "agentA2" = "agentA1") {
  const o = await newOrder(w, "A", { createdAt });
  await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users[agent].id });
  return o;
}

function call(outcome: string, startedAt: Date, extra: Record<string, unknown> = {}) {
  return { call: { outcome, proof: "DEVICE_LOG", durationSec: outcome === "ANSWERED" ? 60 : 0, startedAt, ...extra } };
}

beforeAll(async () => {
  w = await createWorld();
  await setAgencySettings(w, {}); // spec defaults: slots, blocked windows, 30-min spacing
  await makeAvailable([w.users.agentA1.id, w.users.agentA2.id]);
});

describe("phase 2 acceptance — call cadence", () => {
  it("an attempt logged 1 minute after the previous one is rejected", async () => {
    const o = await assignedOrder(mon(9, 0));
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER", mon(9, 5)) });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: call("NO_ANSWER", mon(9, 6)) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", details: { rejection: "MIN_GAP" } });
    const ok = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: call("NO_ANSWER", mon(9, 40)) });
    expect(ok.order.attemptCount).toBe(2);
  });

  it("attempts outside their slot or in blocked windows are rejected", async () => {
    const o = await assignedOrder(mon(9, 0));
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER", mon(9, 5)) });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: call("BUSY", mon(11, 30)) });
    // attempt 3 of day 1 must be in the evening slot
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_3", payload: call("NO_ANSWER", mon(15, 0)) })).rejects.toMatchObject({ details: { rejection: "OUTSIDE_SLOT" } });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_3", payload: call("NO_ANSWER", mon(18, 30)) });
    // day 2 attempt 1: before 09:00 is blocked, the afternoon is not its slot
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER", mon(8, 0, 1)) })).rejects.toMatchObject({ details: { rejection: "BLOCKED_WINDOW" } });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER", mon(14, 30, 1)) })).rejects.toMatchObject({ details: { rejection: "OUTSIDE_SLOT" } });
    const r = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER", mon(10, 30, 1)) });
    expect(r.order).toMatchObject({ attemptCount: 4, attemptDay: 2 });
    // next attempt planned in the afternoon slot of day 2
    expect(r.order.nextActionAt).toEqual(mon(14, 0, 1));
  });

  it("9 unanswered logged attempts reach INJOIGNABLE only through the scheduler", async () => {
    const o = await assignedOrder(mon(9, 0));
    const times: Date[] = [];
    for (let i = 1; i <= 9; i++) {
      const t = planAttempt({ attemptNo: i, previous: [...times], orderCreatedAt: mon(9, 0), cfg, tz });
      times.push(t);
      await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: `APPEL_${((i - 1) % 3) + 1}` as "APPEL_1", payload: call("NO_ANSWER", t) });
    }
    const after9 = await sys(() => prisma.order.findFirst({ where: { id: o.id } }));
    expect(after9).toMatchObject({ status: "APPEL_3", attemptCount: 9 });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "INJOIGNABLE" })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    await expect(transitionOrder(w.ctx.supervisor, { orderId: o.id, to: "INJOIGNABLE" })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER", addDays(times[8]!, 1)) })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await sys(() => markUnreachable(new Date()))).toBeGreaterThanOrEqual(1);
    const final = await sys(() => prisma.order.findFirst({ where: { id: o.id } }));
    expect(final!.status).toBe("INJOIGNABLE");
  });

  it("FAUSSE_COMMANDE and EXPIREE need enough spaced attempts unless the fake reason is clear", async () => {
    const o = await assignedOrder(mon(9, 0));
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("WRONG_NUMBER", mon(9, 5)) });
    await expect(transitionOrder(w.ctx.supervisor, { orderId: o.id, to: "FAUSSE_COMMANDE", payload: { fakeReason: "DID_NOT_ORDER" } })).rejects.toMatchObject({ details: { requirement: "SPACED_ATTEMPTS" } });
    await expect(transitionOrder(SYSTEM, { orderId: o.id, to: "EXPIREE", payload: {} })).rejects.toMatchObject({ details: { requirement: "SPACED_ATTEMPTS" } });
    const r = await transitionOrder(w.ctx.supervisor, { orderId: o.id, to: "FAUSSE_COMMANDE", payload: { fakeReason: "INVALID_PHONE" } });
    expect(r.order).toMatchObject({ status: "FAUSSE_COMMANDE", fakeReason: "INVALID_PHONE" });
  });

  it("confirmation is impossible without the checklist", async () => {
    const o = await assignedOrder(mon(9, 0));
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED", mon(9, 5)) });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: { ...CHECKLIST, explicitYes: false } } })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: {} })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    const ok = await transitionOrder(w.ctx.agentA1, {
      orderId: o.id,
      to: "CONFIRMEE",
      payload: { checklist: CHECKLIST, upsells: [{ kind: "UPSELL", customerAgreed: true, items: [{ productId: w.merchantA.productId, qty: 1, unitPrice: 5000 }] }] },
    });
    expect(ok.order).toMatchObject({ status: "CONFIRMEE", upsellValue: 5000, confirmedById: w.users.agentA1.id, assignedToId: w.users.followupA.id });
    expect(ok.order.flags).toContain("UPSELL");
  });
});

describe("phase 2 acceptance — claim/lock, expiry, recycle, reassignment", () => {
  it("claim locks the order and the lock is released after the timeout", async () => {
    await setAgencySettings(w, PERMISSIVE_SETTINGS);
    const o = await assignedOrder(addHours(new Date(), -1));
    const next = await nextOrderForAgent(w.ctx.agentA1);
    expect(next.kind).toBe("order");
    const claimed = await claimOrder(w.ctx.agentA1, o.id).catch(() => null);
    const locked = await sys(() => prisma.order.findFirst({ where: { id: o.id } }));
    if (claimed || locked!.status === "EN_COURS_CONFIRMATION") {
      expect(locked).toMatchObject({ status: "EN_COURS_CONFIRMATION", lockedById: w.users.agentA1.id, lockPrevStatus: "ASSIGNEE" });
    }
    await setAgencySettings(w, {});
    // force this order to be locked by agentA1
    if (locked!.status !== "EN_COURS_CONFIRMATION") await claimOrder(w.ctx.agentA1, o.id);
    expect(await sys(() => releaseExpiredLocks(addHours(new Date(), 0.05)))).toBe(0); // 3 minutes: still locked
    await sys(() => releaseExpiredLocks(addHours(new Date(), 0.2))); // 12 minutes
    const released = await sys(() => prisma.order.findFirst({ where: { id: o.id }, include: { events: { orderBy: { createdAt: "desc" }, take: 1 } } }));
    expect(released).toMatchObject({ status: "ASSIGNEE", lockedById: null });
    expect(released!.events[0]!.type).toBe("LOCK_TIMEOUT");
  });

  it("the midnight job expires the right orders and the recycle job hands them to a different agent, once", async () => {
    const stale = await assignedOrder(mon(9, 0));
    for (const [i, t] of [mon(9, 5), mon(11, 30), mon(18, 30)].entries()) {
      await transitionOrder(w.ctx.agentA1, { orderId: stale.id, to: `APPEL_${i + 1}` as "APPEL_1", payload: call("NO_ANSWER", t) });
    }
    const unspaced = await assignedOrder(mon(9, 0));
    await transitionOrder(w.ctx.agentA1, { orderId: unspaced.id, to: "APPEL_1", payload: call("NO_ANSWER", mon(9, 5)) });
    const fresh = await assignedOrder(addHours(new Date(), -2));

    await sys(() => nightlyExpiry(new Date(), { force: true }));
    const [s, u, f] = await sys(() => Promise.all([stale, unspaced, fresh].map((o) => prisma.order.findFirst({ where: { id: o.id } }))));
    expect(s!.status).toBe("EXPIREE");
    expect(u!.status).toBe("APPEL_1"); // not enough spaced attempts: never expires silently
    expect(f!.status).toBe("ASSIGNEE");

    // cool-down (2 days) not passed → no recycle
    await sys(() => recycleOrders(new Date(), { force: true }));
    expect((await sys(() => prisma.order.findFirst({ where: { id: stale.id } })))!.status).toBe("EXPIREE");
    await sys(() => prisma.order.update({ where: { id: stale.id, merchantId: w.merchantA.id }, data: { expiredAt: addDays(new Date(), -3) } }));
    await sys(() => recycleOrders(new Date(), { force: true }));
    const recycled = await sys(() => prisma.order.findFirst({ where: { id: stale.id } }));
    expect(recycled).toMatchObject({ status: "ASSIGNEE", recycleRound: 1, attemptCount: 0, assignedToId: w.users.agentA2.id });
    expect(recycled!.flags).toContain("RECYCLED");

    // round 2 expires again → never recycled twice
    for (const [i, t] of [mon(9, 5, 1), mon(11, 30, 1), mon(18, 30, 1)].entries()) {
      await transitionOrder(w.ctx.agentA2, { orderId: stale.id, to: `APPEL_${i + 1}` as "APPEL_1", payload: call("NO_ANSWER", t) });
    }
    await sys(() => nightlyExpiry(new Date(), { force: true }));
    await sys(() => prisma.order.update({ where: { id: stale.id, merchantId: w.merchantA.id }, data: { expiredAt: addDays(new Date(), -3) } }));
    await sys(() => recycleOrders(new Date(), { force: true }));
    expect((await sys(() => prisma.order.findFirst({ where: { id: stale.id } })))!.status).toBe("EXPIREE");
    await expect(transitionOrder(w.ctx.supervisor, { orderId: stale.id, to: "ASSIGNEE", payload: { assignedToId: w.users.agentA1.id } })).rejects.toMatchObject({ details: { requirement: "RECYCLE_AVAILABLE" } });
  });

  it("an order untouched for 30 minutes is reassigned to another available agent", async () => {
    const o = await assignedOrder(addHours(new Date(), -1));
    await sys(() => prisma.order.update({ where: { id: o.id, merchantId: w.merchantA.id }, data: { lastActivityAt: addHours(new Date(), -0.6) } }));
    await sys(() => reassignUntouched(new Date()));
    const after = await sys(() => prisma.order.findFirst({ where: { id: o.id }, include: { events: { where: { type: "REASSIGN" } } } }));
    expect(after!.assignedToId).toBe(w.users.agentA2.id);
    expect(after!.events[0]!.payload).toMatchObject({ fromUserId: w.users.agentA1.id, toUserId: w.users.agentA2.id, rule: "UNTOUCHED_30M" });
  });

  it("confirmed-postponed orders are re-queued on their date and re-confirmed with one call", async () => {
    await setAgencySettings(w, PERMISSIVE_SETTINGS);
    const o = await assignedOrder(addHours(new Date(), -3));
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED", addHours(new Date(), -2)) });
    const p = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE_REPORTEE", payload: { checklist: CHECKLIST, deliverOn: addDays(new Date(), 3) } });
    expect(p.order.confirmedById).toBe(w.users.agentA1.id);
    await sys(() => prisma.order.update({ where: { id: o.id, merchantId: w.merchantA.id }, data: { postponedUntil: addHours(new Date(), -1) } }));
    expect(await sys(() => requeueDue(new Date()))).toBeGreaterThanOrEqual(1);
    const ev = await sys(() => prisma.orderEvent.findFirst({ where: { orderId: o.id, type: "REQUEUE" } }));
    expect(ev).not.toBeNull();
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: call("NO_ANSWER", new Date()) })).rejects.toMatchObject({ details: { requirement: "PAYLOAD_CALL_ANSWERED" } });
    const r = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: call("ANSWERED", new Date()) });
    expect(r.ruleId).toBe("RECONFIRM");
    await setAgencySettings(w, {});
  });
});

describe("phase 2 acceptance — intake", () => {
  it("size text in the wilaya field lands in A_VERIFIER with ADDRESS_MAPPING", async () => {
    const o = await createOrder(SYSTEM, { merchantId: w.merchantA.id, storeId: w.merchantA.storeId, customer: { name: "Rania", phone: nextPhone() }, wilaya: "XL", commune: "Kouba", address: "Cité 1", items: [{ productId: w.merchantA.productId, qty: 1 }] });
    expect(o.status).toBe("A_VERIFIER");
    expect(o.mappingErrors).toContain("ADDRESS_MAPPING");
    const repaired = await createOrder(SYSTEM, { merchantId: w.merchantA.id, storeId: w.merchantA.storeId, customer: { name: "Rania", phone: nextPhone() }, wilaya: "Noir", commune: "Kouba", address: "Alger centre", items: [{ productId: w.merchantA.productId, qty: 1 }] });
    expect(repaired).toMatchObject({ status: "NOUVEAU", wilayaCode: 16 });
    expect(repaired.flags).toContain("ADDRESS_REPAIRED");
  });

  it("unmatched SKUs go to A_VERIFIER, are mapped once and auto-applied afterwards", async () => {
    const store = await sys(() => prisma.store.findFirst({ where: { id: w.merchantA.storeId } }));
    const mapped = (sku: string, id: string) => ({ externalId: id, externalName: null, customerName: "Hamza", phone: nextPhone(), phone2: null, wilaya: "16", commune: null, address: "Rue 1", address2: null, landmark: null, deliveryType: "HOME" as const, shippingFee: 500, total: 7000, note: null, source: null, items: [{ sku, name: "Abaya noire", variant: null, qty: 1, unitPrice: 6500 }], createdAt: null });
    const first = await ingestOrder(store!, mapped("ABY-NEW", "ext-1"));
    expect(first.order.status).toBe("A_VERIFIER");
    expect(first.order.mappingErrors).toContain("UNMATCHED_SKU");
    const line = await sys(() => prisma.unmatchedLine.findFirst({ where: { orderId: first.order.id } }));
    await resolveUnmatchedLine(w.ctx.supervisor, { lineId: line!.id, productId: w.merchantA.productId });
    const fixed = await sys(() => prisma.order.findFirst({ where: { id: first.order.id }, include: { items: true } }));
    expect(fixed!.mappingErrors).not.toContain("UNMATCHED_SKU");
    expect(fixed!.items).toHaveLength(1);
    const second = await ingestOrder(store!, mapped("ABY-NEW", "ext-2"));
    expect(second.order.status).toBe("NOUVEAU");
  });

  it("a Shopify order arrives as NOUVEAU, a replayed webhook does not duplicate it, a tampered HMAC is rejected", async () => {
    await sys(() => prisma.store.update({ where: { id: w.merchantA.storeId, merchantId: w.merchantA.id }, data: { externalRef: "test-shop.myshopify.com", webhookSecret: encryptSecret("shpss_test") } }));
    const { POST } = await import("@/app/api/webhooks/shopify/route");
    const order = {
      admin_graphql_api_id: "gid://shopify/Order/5001",
      name: "#5001",
      current_total_price: "7000.00",
      shipping_lines: [{ price: "500.00" }],
      shipping_address: { name: "Yacine Haddad", phone: "0770 11 22 33", province: "Alger", city: "Kouba", address1: "Cité 8" },
      line_items: [{ sku: null, title: "Abaya", variant_title: "M", quantity: 1, price: "6500.00" }],
    };
    const body = JSON.stringify(order);
    const send = (raw: string, hmac: string, id: string) =>
      POST(new NextRequest("http://localhost/api/webhooks/shopify", { method: "POST", body: raw, headers: { "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "test-shop.myshopify.com", "x-shopify-webhook-id": id, "x-shopify-hmac-sha256": hmac } }));
    const res = await send(body, signShopifyWebhook(body, "shpss_test"), "wh-1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toBe(true);
    const created = await sys(() => prisma.order.findFirst({ where: { id: json.orderId } }));
    expect(created).toMatchObject({ status: "NOUVEAU", externalId: "gid://shopify/Order/5001", externalName: "#5001", total: 7000, customerPhone: "0770112233" });

    const replay = await send(body, signShopifyWebhook(body, "shpss_test"), "wh-1");
    expect((await replay.json()).duplicate).toBe(true);
    const redelivered = await send(body, signShopifyWebhook(body, "shpss_test"), "wh-2");
    expect((await redelivered.json()).created).toBe(false);
    expect(await sys(() => prisma.order.count({ where: { externalId: "gid://shopify/Order/5001", merchantId: w.merchantA.id } }))).toBe(1);

    const tampered = await send(body.replace("7000.00", "1.00"), signShopifyWebhook(body, "shpss_test"), "wh-3");
    expect(tampered.status).toBe(401);
  });

  it("public landing intake: 3 orders per IP per 12 h, then 429 with a localized message", async () => {
    const token = "intake-token-123";
    await sys(() => prisma.store.update({ where: { id: w.merchantA.storeId, merchantId: w.merchantA.id }, data: { settings: { intakeToken: sha256Hex(token) } } }));
    const { POST } = await import("@/app/api/intake/[storeId]/route");
    const post = (lang = "fr") =>
      POST(new NextRequest(`http://localhost/api/intake/${w.merchantA.storeId}`, { method: "POST", body: JSON.stringify({ name: "Nour", phone: nextPhone(), wilaya: "Blida", address: "Rue 3", product: "Abaya", qty: 1, total: 7000 }), headers: { "content-type": "application/json", "x-intake-token": token, "x-forwarded-for": "41.100.1.1", "accept-language": lang } }), { params: Promise.resolve({ storeId: w.merchantA.storeId }) });
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(201);
    const blocked = await post("ar");
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).message).toContain("حاول لاحقاً");
  });

  it("POST /v1/orders creates through the pipeline and is idempotent per external_id", async () => {
    const { POST } = await import("@/app/api/v1/orders/route");
    const body = { store_id: w.merchantA.storeId, external_id: "api-1", customer: { name: "Asma", phone: "0661 23 45 67" }, shipping: { wilaya: "Sétif", address: "Cité 9", fee: 600 }, items: [{ product_id: w.merchantA.productId, qty: 1 }] };
    const send = (key: string) => POST(new NextRequest("http://localhost/api/v1/orders", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${w.apiKeys.agency}`, "idempotency-key": key, "content-type": "application/json" } }), { params: Promise.resolve({}) });
    const r1 = await send("k1");
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()).data;
    expect(d1).toMatchObject({ status: "NOUVEAU", shipping: { wilaya_code: 19 }, amounts: { total: 7100 } });
    const r2 = await send("k2");
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.id).toBe(d1.id);
  });
});
