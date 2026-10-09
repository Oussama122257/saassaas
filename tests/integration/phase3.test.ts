import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { Job } from "bullmq";
import { prisma, withSystemContext } from "@/lib/db";
import { memoryJobs, type JobPayloads } from "@/lib/queue";
import { assignOrder, transitionOrder } from "@/lib/orders/orderTransitions";
import { sendOrderMessage } from "@/lib/messaging/send";
import { creditBalance, topUpCredits } from "@/lib/messaging/credits";
import { mockOutbox } from "@/lib/adapters/messaging/mock";
import { signMeta } from "@/lib/adapters/messaging/whatsappCloud";
import { startCall } from "@/lib/calls/proof";
import { createDeviceToken } from "@/lib/devices/tokens";
import { handleStatusChanged } from "@/worker/jobs/statusChanged";
import { addHours } from "@/lib/time";
import { createWorld, newOrder, nextPhone, PERMISSIVE_SETTINGS, SYSTEM, type World } from "./fixtures";

let w: World;
const sys = <T,>(fn: () => Promise<T>) => withSystemContext("test", fn);

beforeAll(async () => {
  w = await createWorld();
  process.env.WHATSAPP_APP_SECRET = "wa-app-secret";
  process.env.TELEPHONY_WEBHOOK_SECRET = "tel-secret";
  for (const m of [w.merchantA.id, w.merchantB.id]) await topUpCredits(m, 100);
});

beforeEach(() => {
  memoryJobs.length = 0;
});

function jobsNamed<N extends keyof JobPayloads>(name: N): JobPayloads[N][] {
  return memoryJobs.filter((j) => j.name === name).map((j) => j.data as JobPayloads[N]);
}

async function runSideEffects() {
  for (const data of jobsNamed("order.status_changed")) await handleStatusChanged({ data } as Job<JobPayloads["order.status_changed"]>);
}

describe("phase 3 acceptance — messaging", () => {
  it("the missed-call message is sent after the first failed attempt (and only then)", async () => {
    const o = await newOrder(w, "A");
    await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users.agentA1.id });
    memoryJobs.length = 0;
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: { call: { outcome: "NO_ANSWER", proof: "DEVICE_LOG", durationSec: 0 } } });
    await runSideEffects();
    const msgs = jobsNamed("message.send").filter((m) => m.orderId === o.id);
    expect(msgs.map((m) => m.template)).toEqual(["missed_call_1"]);

    const before = await creditBalance(w.merchantA.id);
    const r = await sendOrderMessage(o.id, "missed_call_1");
    expect(r.status).toBe("SENT");
    expect(await creditBalance(w.merchantA.id)).toBe(before - 1);
    const log = await sys(() => prisma.messageLog.findFirst({ where: { orderId: o.id, template: "missed_call_1" } }));
    expect(log).toMatchObject({ status: "SENT", channel: "WHATSAPP", cost: 1 });
    expect(log!.body).toContain("Test Client");

    // second failed attempt: no second missed-call message
    memoryJobs.length = 0;
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: { call: { outcome: "BUSY", proof: "DEVICE_LOG", durationSec: 0 } } });
    await runSideEffects();
    expect(jobsNamed("message.send")).toHaveLength(0);
    // and the same event is never sent twice
    expect((await sendOrderMessage(o.id, "missed_call_1")).status).toBe("SKIPPED_DUPLICATE");
  });

  it("a reply on the bot button sets CONFIRMEE_BOT; a high-value bot order gets a verification task instead of shipping", async () => {
    const { POST } = await import("@/app/api/webhooks/whatsapp/route");
    const reply = async (from: string, contextId: string) => {
      const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, type: "button", button: { payload: "Je confirme", text: "Je confirme" }, context: { id: contextId } }] } }] }] });
      return POST(new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": signMeta(body, "wa-app-secret") } }));
    };

    const normal = await newOrder(w, "A");
    await assignOrder(SYSTEM, { orderId: normal.id, toUserId: w.users.agentA1.id });
    const sent = await sendOrderMessage(normal.id, "bot_confirm_request");
    expect(sent.status).toBe("SENT");
    const res = await reply(`213${normal.customerPhone.slice(1)}`, sent.providerId!);
    expect(res.status).toBe(200);
    const after = await sys(() => prisma.order.findFirst({ where: { id: normal.id } }));
    expect(after).toMatchObject({ status: "CONFIRMEE_BOT", assignedToId: w.users.followupA.id });
    expect(after!.flags).toContain("BOT_CONFIRMED");

    const big = await newOrder(w, "A", { items: [{ productId: w.merchantA.productId, qty: 4 }] }); // 26 000 DA ≥ 15 000
    expect(big.flags).toContain("HIGH_VALUE");
    await assignOrder(SYSTEM, { orderId: big.id, toUserId: w.users.agentA1.id });
    const sentBig = await sendOrderMessage(big.id, "bot_confirm_request");
    await reply(`213${big.customerPhone.slice(1)}`, sentBig.providerId!);
    const bigAfter = await sys(() => prisma.order.findFirst({ where: { id: big.id }, include: { tasks: true } }));
    expect(bigAfter!.status).toBe("CONFIRMEE_BOT");
    expect(bigAfter!.flags).toContain("NEEDS_VERIFICATION");
    expect(bigAfter!.tasks.map((t) => t.type)).toContain("VERIFY_BOT_CONFIRMATION");
    // cannot be packed until verified
    await expect(transitionOrder(w.ctx.warehouse, { orderId: big.id, to: "PRET_A_EXPEDIER", payload: {} })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects unsigned webhooks and replies from another number", async () => {
    const { POST, GET } = await import("@/app/api/webhooks/whatsapp/route");
    const body = JSON.stringify({ entry: [] });
    expect((await POST(new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=00" } }))).status).toBe(401);
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
    const ok = GET(new NextRequest("http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"));
    expect(await ok.text()).toBe("42");
    expect(GET(new NextRequest("http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42")).status).toBe(403);

    const o = await newOrder(w, "A");
    await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users.agentA1.id });
    const sent = await sendOrderMessage(o.id, "bot_confirm_request");
    const spoof = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "213799999999", type: "button", button: { payload: "x" }, context: { id: sent.providerId } }] } }] }] });
    const r = await POST(new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", body: spoof, headers: { "x-hub-signature-256": signMeta(spoof, "wa-app-secret") } }));
    expect((await r.json()).botConfirmed).toEqual([]);
    expect((await sys(() => prisma.order.findFirst({ where: { id: o.id } })))!.status).toBe("ASSIGNEE");
  });

  it("skips non-mobile numbers for free, refuses when credits run out, falls back to SMS when WhatsApp fails", async () => {
    const landline = await newOrder(w, "B", { customer: { name: "Fixe", phone: "021123456" } });
    const skip = await sendOrderMessage(landline.id, "shipped");
    expect(skip.status).toBe("SKIPPED_NOT_MOBILE");

    const failing = await newOrder(w, "B", { customer: { name: "Fail", phone: "0550120000" } });
    const before = await creditBalance(w.merchantB.id);
    mockOutbox.length = 0;
    const fb = await sendOrderMessage(failing.id, "shipped");
    expect(fb.channel).toBe("SMS");
    const logs = await sys(() => prisma.messageLog.findMany({ where: { orderId: failing.id }, orderBy: { sentAt: "asc" } }));
    expect(logs.map((l) => `${l.channel}:${l.status}`).sort()).toEqual(["SMS:FAILED", "WHATSAPP:FAILED"]); // mock fails both for *0000
    expect(await creditBalance(w.merchantB.id)).toBe(before); // failed sends are refunded

    const broke = await sys(() => prisma.organization.create({ data: { type: "MERCHANT", name: "Broke", slug: `broke-${Date.now()}`, settings: PERMISSIVE_SETTINGS } }));
    const store = await sys(() => prisma.store.create({ data: { merchantId: broke.id, name: "S", channel: "MANUAL" } }));
    const product = await sys(() => prisma.product.create({ data: { merchantId: broke.id, name: "P", price: 1000 } }));
    const { createOrder } = await import("@/lib/orders/orderTransitions");
    const o = await createOrder(SYSTEM, { merchantId: broke.id, storeId: store.id, customer: { name: "X", phone: nextPhone() }, wilaya: 16, address: "Rue", items: [{ productId: product.id, qty: 1 }] });
    expect((await sendOrderMessage(o.id, "shipped")).status).toBe("SKIPPED_NO_CREDIT");
  });

  it("defers messages in quiet hours", async () => {
    await sys(() => prisma.organization.update({ where: { id: w.agency.id }, data: { settings: {} } }));
    const o = await newOrder(w, "A");
    await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users.agentA1.id });
    const night = new Date("2026-09-28T22:30:00Z"); // 23:30 in Algiers
    const r = await sendOrderMessage(o.id, "shipped", { now: night });
    expect(r.status).toBe("DEFERRED");
    expect(r.deferUntil!.toISOString()).toBe("2026-09-29T08:00:00.000Z"); // 09:00 next morning
    await sys(() => prisma.organization.update({ where: { id: w.agency.id }, data: { settings: { calls: { strictSlots: false, dayStartMin: 0, dayEndMin: 1440, prayerWindows: [], fridayBlock: null, minAttemptGapMin: 0, minSlotsToClose: 1, minSpacedAttemptsToClose: 1 } } } }));
  });
});

describe("phase 3 — call proof and tracking", () => {
  it("the Android device log attaches DEVICE_LOG proof to the call started from the platform", async () => {
    const o = await newOrder(w, "A");
    await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users.agentA1.id });
    const call = await startCall(w.ctx.agentA1, o.id);
    expect(call.dialUri).toMatch(/^codcc:\/\/dial\?ref=/);
    const token = await createDeviceToken(w.users.agentA1.id, w.agency.id, "Test phone");
    const { POST } = await import("@/app/api/v1/calls/device-log/route");
    const started = addHours(new Date(), -0.1);
    const res = await POST(new NextRequest("http://localhost/api/v1/calls/device-log", { method: "POST", body: JSON.stringify({ entries: [{ call_ref: call.callRef, number: o.customerPhone, started_at: started.toISOString(), duration_sec: 52, type: "OUTGOING" }] }), headers: { authorization: `Device ${token}` } }));
    expect((await res.json()).data).toMatchObject({ matched: 1 });
    const bad = await POST(new NextRequest("http://localhost/api/v1/calls/device-log", { method: "POST", body: "{}", headers: { authorization: "Device nope" } }));
    expect(bad.status).toBe(401);

    // the agent logs the outcome → attempt carries the device proof
    const { pendingSession, proofOf, linkSessionToAttempt } = await import("@/lib/calls/proof");
    const s = await pendingSession(o.id, w.users.agentA1.id);
    const p = proofOf(s!)!;
    expect(p).toMatchObject({ proof: "DEVICE_LOG", durationSec: 52, suggestedOutcome: "ANSWERED" });
    const r = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: { call: { outcome: "ANSWERED", proof: p.proof, startedAt: p.startedAt, durationSec: p.durationSec } } });
    await linkSessionToAttempt(p.sessionId, (r.event.payload as { callAttemptId: string }).callAttemptId);
    const attempt = await sys(() => prisma.callAttempt.findFirst({ where: { orderId: o.id } }));
    expect(attempt).toMatchObject({ proof: "DEVICE_LOG", durationSec: 52 });
  });

  it("a VoIP CDR webhook attaches VOIP_LOG proof (mock provider, shared secret)", async () => {
    const o = await newOrder(w, "A");
    await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users.agentA1.id });
    const call = await startCall(w.ctx.agentA1, o.id);
    const { POST } = await import("@/app/api/webhooks/telephony/[provider]/route");
    const send = (secret: string) => POST(new NextRequest("http://localhost/api/webhooks/telephony/mock", { method: "POST", body: JSON.stringify({ callRef: call.callRef, durationSec: 0, outcome: "NO_ANSWER" }), headers: { "x-telephony-secret": secret } }), { params: Promise.resolve({ provider: "mock" }) });
    expect((await send("wrong")).status).toBe(401);
    expect((await (await send("tel-secret")).json()).matched).toBe(1);
    const session = await sys(() => prisma.callSession.findUnique({ where: { callRef: call.callRef } }));
    expect(session).toMatchObject({ proof: "VOIP_LOG", status: "NO_ANSWER" });
  });

  it("the public tracking page and short links work without login", async () => {
    const o = await newOrder(w, "A");
    await sendOrderMessage(o.id, "shipped", { channel: "SMS" });
    const order = await sys(() => prisma.order.findFirst({ where: { id: o.id } }));
    expect(order!.trackingToken).toBeTruthy();
    const link = await sys(() => prisma.shortLink.findFirst({ where: { orderId: o.id } }));
    expect(link!.url).toContain(`/t/${order!.trackingToken}`);
    const { GET } = await import("@/app/s/[code]/route");
    const res = await GET(new NextRequest(`http://localhost/s/${link!.code}`), { params: Promise.resolve({ code: link!.code }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(order!.trackingToken!);
  });
});
