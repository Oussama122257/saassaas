import { beforeAll, describe, expect, it } from "vitest";
import { prisma, withSystemContext } from "@/lib/db";
import { memoryJobs } from "@/lib/queue";
import { ForbiddenError } from "@/lib/tenant";
import { assignOrder, createOrder, overrideOrderStatus, proposeFakeOrder, transitionOrder } from "@/lib/orders/orderTransitions";
import { CHECKLIST, createWorld, newOrder, nextPhone, SYSTEM, type World } from "./fixtures";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});

const call = (outcome: "ANSWERED" | "NO_ANSWER" | "BUSY" | "OFF" | "WRONG_NUMBER", extra: Record<string, unknown> = {}) => ({
  call: { outcome, proof: "DEVICE_LOG", durationSec: outcome === "ANSWERED" ? 45 : 0, ...extra },
});

async function assigned(agent: "agentA1" | "agentA2" | "agentB1" = "agentA1") {
  const o = await newOrder(w, agent === "agentB1" ? "B" : "A");
  await assignOrder(SYSTEM, { orderId: o.id, toUserId: w.users[agent].id });
  return o;
}

describe("creation", () => {
  it("creates NOUVEAU with a per-merchant sequence, customer upsert and an audit event", async () => {
    const phone = nextPhone();
    const o1 = await newOrder(w, "A", { customer: { name: "Amine", phone } });
    const o2 = await newOrder(w, "A", { customer: { name: "Amine", phone: `+213${phone.slice(1)}` }, items: [{ productId: w.merchantA.productId, qty: 2 }] });
    expect(o1.status).toBe("NOUVEAU");
    expect(o2.seq).toBe(o1.seq + 1);
    expect(o2.customerId).toBe(o1.customerId);
    expect(o2.customerPhone).toBe(phone);
    expect(o2.total).toBe(6500 * 2 + 500);
    const customer = await prisma.customer.findFirst({ where: { id: o1.customerId, merchantId: w.merchantA.id } });
    expect(customer?.ordersCount).toBe(2);
    const events = await prisma.orderEvent.findMany({ where: { orderId: o1.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "STATUS_CHANGE", fromStatus: null, toStatus: "NOUVEAU", actorId: null });
  });

  it("detects duplicates (same phone + same product within 48 h) → DOUBLE via the system", async () => {
    const phone = nextPhone();
    const first = await newOrder(w, "A", { customer: { phone } });
    const dup = await newOrder(w, "A", { customer: { phone }, skipDuplicateCheck: false });
    expect(dup.status).toBe("DOUBLE");
    expect(dup.duplicateOfId).toBe(first.id);
    expect(dup.flags).toContain("DUPLICATE_SUSPECT");
    const events = await prisma.orderEvent.findMany({ where: { orderId: dup.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toStatus)).toEqual(["NOUVEAU", "DOUBLE"]);
  });

  it("flags invalid phones and unknown wilayas as A_VERIFIER with a supervisor task", async () => {
    const o = await createOrder(SYSTEM, {
      merchantId: w.merchantA.id,
      storeId: w.merchantA.storeId,
      customer: { name: "Bad", phone: "0812345" },
      wilaya: "Atlantis",
      items: [{ productId: w.merchantA.productId, qty: 1 }],
    });
    expect(o.status).toBe("A_VERIFIER");
    expect(o.flags).toEqual(expect.arrayContaining(["INVALID_PHONE", "UNKNOWN_WILAYA"]));
    expect(await prisma.task.count({ where: { orderId: o.id, type: "VERIFY_ORDER" } })).toBe(1);
  });

  it("flags high-value orders", async () => {
    const o = await newOrder(w, "A", { items: [{ productId: w.merchantA.productId, qty: 3 }] });
    expect(o.total).toBeGreaterThanOrEqual(15000);
    expect(o.flags).toContain("HIGH_VALUE");
  });

  it("read-only roles cannot create orders", async () => {
    await expect(newOrder(w, "A").then(() => createOrder(w.ctx.clientA, { merchantId: w.merchantA.id, storeId: w.merchantA.storeId, customer: { phone: nextPhone() }, wilaya: 16, items: [{ productId: w.merchantA.productId, qty: 1 }] }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("illegal transitions and actors", () => {
  it("rejects transitions that are not in the table", async () => {
    const o = await newOrder(w, "A");
    await expect(transitionOrder(w.ctx.supervisor, { orderId: o.id, to: "LIVRE", payload: {} })).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    await expect(transitionOrder(SYSTEM, { orderId: o.id, to: "EXPEDIE", payload: { trackingNumber: "x1" } })).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("an agent can never set INJOIGNABLE — not through the table, not through an override", async () => {
    const o = await assigned();
    for (let i = 0; i < 9; i++) await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: `APPEL_${(i % 3) + 1}` as never, payload: call("NO_ANSWER") });
    const nine = await prisma.order.findFirst({ where: { id: o.id, merchantId: w.merchantA.id } });
    expect(nine?.attemptCount).toBe(9);
    expect(nine?.status).toBe("APPEL_3");
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "INJOIGNABLE", payload: {} })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    await expect(transitionOrder(w.ctx.supervisor, { orderId: o.id, to: "INJOIGNABLE", payload: {} })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    await expect(transitionOrder(w.ctx.admin, { orderId: o.id, to: "INJOIGNABLE", payload: {} })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    await expect(overrideOrderStatus(w.ctx.supervisor, { orderId: o.id, to: "INJOIGNABLE", reason: "trying anyway" })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    // the 10th attempt is refused
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER") })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // only the system can close it, and only at 9 attempts
    const r = await transitionOrder(SYSTEM, { orderId: o.id, to: "INJOIGNABLE", payload: {} });
    expect(r.order.status).toBe("INJOIGNABLE");
    expect(r.event.actorId).toBeNull();
    expect(r.event.payload).toMatchObject({ ruleId: "UNREACHABLE", actor: "SYSTEM" });
  });

  it("the system cannot set INJOIGNABLE before 9 attempts", async () => {
    const o = await assigned();
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER") });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: call("NO_ANSWER") });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_3", payload: call("NO_ANSWER") });
    await expect(transitionOrder(SYSTEM, { orderId: o.id, to: "INJOIGNABLE", payload: {} })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("APPEL_n must match the attempt counter and proof is mandatory", async () => {
    const o = await assigned();
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: call("NO_ANSWER") })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", details: { expected: "APPEL_1" } });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: { call: { outcome: "NO_ANSWER", proof: "NONE" } } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", details: { requirement: "CALL_PROOF" } });
    const r = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER") });
    expect(r.order.attemptCount).toBe(1);
    expect(r.order.nextActionAt).not.toBeNull();
    const calls = await prisma.callAttempt.findMany({ where: { orderId: o.id } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ attemptNo: 1, day: 1, agentId: w.users.agentA1.id });
  });

  it("warehouse cannot confirm, agents cannot ship, client viewers cannot do anything", async () => {
    const o = await assigned();
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED") });
    await expect(transitionOrder(w.ctx.warehouse, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST } })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    await expect(transitionOrder(w.ctx.clientA, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST } })).rejects.toBeInstanceOf(ForbiddenError);
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST } });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "PRET_A_EXPEDIER", payload: {} })).rejects.toMatchObject({ code: "NOT_ORDER_OWNER" }); // handed off to follow-up
    await expect(transitionOrder(w.ctx.followupA, { orderId: o.id, to: "PRET_A_EXPEDIER", payload: {} })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    const r = await transitionOrder(w.ctx.warehouse, { orderId: o.id, to: "PRET_A_EXPEDIER", payload: {} });
    expect(r.order.status).toBe("PRET_A_EXPEDIER");
  });
});

describe("confirmation rules", () => {
  it("is impossible without the full checklist", async () => {
    const o = await assigned();
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED") });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: {} })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: { ...CHECKLIST, explicitYes: false } } })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("is impossible without an answered call", async () => {
    const o = await assigned();
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("NO_ANSWER") });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", details: { requirement: "ANSWERED_CALL" } });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_2", payload: call("ANSWERED", { durationSec: 5 }) });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST } })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); // too short
  });

  it("sets confirmedById, hands off to the pod's follow-up agent and enqueues side effects", async () => {
    memoryJobs.length = 0;
    const o = await assigned("agentA2");
    await transitionOrder(w.ctx.agentA2, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED") });
    const r = await transitionOrder(w.ctx.agentA2, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST, note: "ok" } });
    expect(r.order).toMatchObject({ status: "CONFIRMEE", statusGroup: "CONFIRMATION", confirmedById: w.users.agentA2.id, assignedToId: w.users.followupA.id });
    expect(r.order.confirmedAt).not.toBeNull();
    const job = memoryJobs.find((j) => j.name === "order.status_changed" && (j.data as { to: string; orderId: string }).to === "CONFIRMEE" && (j.data as { orderId: string }).orderId === o.id);
    expect(job).toBeDefined();
    expect((job!.data as { sideEffects: string[] }).sideEffects).toEqual(["SEND_WRITTEN_CONFIRMATION", "RESERVE_STOCK", "HANDOFF_TO_FOLLOWUP"]);
  });

  it("cancel requires a reason (and a note for OTHER); postpone is capped at 7 days", async () => {
    const o = await assigned();
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED") });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "ANNULEE", payload: {} })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "ANNULEE", payload: { cancelReason: "OTHER" } })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "REPORTE", payload: { postponedUntil: new Date(Date.now() + 10 * 86_400_000), reason: "trop loin" } })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    const r = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "REPORTE", payload: { postponedUntil: new Date(Date.now() + 2 * 86_400_000), reason: "voyage" } });
    expect(r.order.nextActionAt?.getTime()).toBe(r.order.postponedUntil?.getTime());
    const r2 = await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "ANNULEE", payload: { cancelReason: "PRICE_TOO_HIGH" } });
    expect(r2.order.cancelReason).toBe("PRICE_TOO_HIGH");
  });

  it("FAUSSE_COMMANDE: agent proposes, supervisor finalizes", async () => {
    const o = await assigned();
    await expect(proposeFakeOrder(w.ctx.agentA1, { orderId: o.id, note: "no call yet" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("WRONG_NUMBER") });
    await proposeFakeOrder(w.ctx.agentA1, { orderId: o.id, note: "wrong number" });
    const flagged = await prisma.order.findFirst({ where: { id: o.id, merchantId: w.merchantA.id } });
    expect(flagged?.flags).toContain("FAKE_PROPOSED");
    expect(flagged?.status).toBe("APPEL_1");
    await expect(transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "FAUSSE_COMMANDE", payload: {} })).rejects.toMatchObject({ code: "FORBIDDEN_ACTOR" });
    const r = await transitionOrder(w.ctx.supervisor, { orderId: o.id, to: "FAUSSE_COMMANDE", payload: { blacklistRequest: true } });
    expect(r.order.flags).toContain("BLACKLIST_REQUESTED");
    expect(r.order.flags).not.toContain("FAKE_PROPOSED");
  });
});

describe("override, assignment and the audit log", () => {
  it("supervisor override needs a reason, writes a flagged OVERRIDE event and an org audit row", async () => {
    const o = await newOrder(w, "A");
    await expect(overrideOrderStatus(w.ctx.agentA1, { orderId: o.id, to: "LIVRE", reason: "because" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(overrideOrderStatus(w.ctx.supervisor, { orderId: o.id, to: "LIVRE", reason: "x" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    const r = await overrideOrderStatus(w.ctx.supervisor, { orderId: o.id, to: "LIVRE", reason: "Delivered by hand at the office" });
    expect(r.order.status).toBe("LIVRE");
    expect(r.order.statusGroup).toBe("DELIVERY");
    expect(r.order.flags).toContain("OVERRIDDEN");
    expect(r.event).toMatchObject({ type: "OVERRIDE", fromStatus: "NOUVEAU", toStatus: "LIVRE", actorId: w.users.supervisor.id });
    expect(r.event.payload).toMatchObject({ flagged: true, reason: "Delivered by hand at the office" });
    const audit = await prisma.auditLog.findMany({ where: { orgId: w.agency.id, action: "ORDER_OVERRIDE", targetId: o.id } });
    expect(audit).toHaveLength(1);
  });

  it("assignment writes ASSIGN then REASSIGN events with old/new agent and rule id", async () => {
    const o = await newOrder(w, "A");
    await expect(assignOrder(w.ctx.agentA1, { orderId: o.id, toUserId: w.users.agentA2.id })).rejects.toBeInstanceOf(ForbiddenError);
    const first = await assignOrder(w.ctx.supervisor, { orderId: o.id, toUserId: w.users.agentA1.id, rule: "MANUAL" });
    expect(first.order).toMatchObject({ status: "ASSIGNEE", assignedToId: w.users.agentA1.id, podId: w.pods.pod1 });
    expect(first.event).toMatchObject({ type: "STATUS_CHANGE", toStatus: "ASSIGNEE" });
    const second = await assignOrder(w.ctx.supervisor, { orderId: o.id, toUserId: w.users.agentA2.id, rule: "MANUAL" });
    expect(second.event).toMatchObject({ type: "REASSIGN" });
    expect(second.event.payload).toMatchObject({ fromUserId: w.users.agentA1.id, toUserId: w.users.agentA2.id, rule: "MANUAL" });
    // cannot assign to someone outside the org
    await expect(assignOrder(w.ctx.supervisor, { orderId: o.id, toUserId: w.users.saasOwner.id })).rejects.toThrow(/not found/);
  });

  it("every status change leaves exactly one immutable event", async () => {
    const o = await assigned();
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "APPEL_1", payload: call("ANSWERED") });
    await transitionOrder(w.ctx.agentA1, { orderId: o.id, to: "CONFIRMEE", payload: { checklist: CHECKLIST } });
    await transitionOrder(w.ctx.warehouse, { orderId: o.id, to: "PRET_A_EXPEDIER", payload: {} });
    await transitionOrder(SYSTEM, { orderId: o.id, to: "EXPEDIE", payload: { trackingNumber: "yal-1" } });
    await transitionOrder(SYSTEM, { orderId: o.id, to: "CLIENT_INJOIGNABLE_LIVREUR", payload: { rawStatus: "no answer" } });
    const events = await withSystemContext("t", () => prisma.orderEvent.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } }));
    expect(events.map((e) => e.toStatus)).toEqual(["NOUVEAU", "ASSIGNEE", "APPEL_1", "CONFIRMEE", "PRET_A_EXPEDIER", "EXPEDIE", "CLIENT_INJOIGNABLE_LIVREUR"]);
    const task = await prisma.task.findFirst({ where: { orderId: o.id, type: "RESCUE_NO_ANSWER" } });
    expect(task?.assigneeId).toBe(w.users.followupA.id);
  });
});
