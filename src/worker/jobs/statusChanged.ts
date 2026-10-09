import type { Job } from "bullmq";
import { enqueue, type JobPayloads } from "@/lib/queue";
import { prisma, withSystemContext } from "@/lib/db";
import { autoAssignOrder } from "@/lib/assign/rules";
import type { SideEffect } from "@/lib/orders/transitions";

/**
 * Runs the side effects attached to a status change. Each handler is idempotent (the job id is
 * derived from the OrderEvent id, so a replayed event is a no-op). Synchronous parts (tasks,
 * hand-off, lock release) already happened inside the transaction; this only does the outside work.
 */
type Payload = JobPayloads["order.status_changed"];

async function orderContact(orderId: string) {
  return withSystemContext("side-effects", () =>
    prisma.order.findFirst({ where: { id: orderId }, select: { id: true, customerPhone: true, customerName: true, total: true, wilayaCode: true, storeId: true, store: { select: { name: true } }, items: { take: 1, select: { product: { select: { name: true } } } } } }),
  );
}

async function sendTemplate(p: Payload, template: string, extra: Record<string, string> = {}) {
  const o = await orderContact(p.orderId);
  if (!o) return;
  await enqueue(
    "message.send",
    {
      orderId: o.id,
      template,
      to: o.customerPhone,
      channel: "WHATSAPP",
      vars: { customer_name: o.customerName ?? "", product: o.items[0]?.product.name ?? "", total: String(o.total), wilaya: String(o.wilayaCode), store_name: o.store.name, ...extra },
    },
    { jobId: `msg:${o.id}:${template}` },
  );
}

const noop = async () => undefined;

const handlers: Record<SideEffect, (p: Payload) => Promise<void>> = {
  SCHEDULE_NEXT_ATTEMPT: noop, // nextActionAt is planned synchronously (src/lib/calls/slots.ts)
  SEND_WRITTEN_CONFIRMATION: (p) => sendTemplate(p, "written_confirmation"),
  RESERVE_STOCK: noop, // TODO(phase 4): StockItem.reserved += qty
  HANDOFF_TO_FOLLOWUP: noop, // done synchronously in applyRule
  WAITING_STOCK_TASK: noop, // task created synchronously
  NOTIFY_SUPERVISOR: async (p) => enqueue("notify.owner", { orgId: p.merchantId, kind: "OUT_OF_STOCK_CONFIRMATION", message: `Order ${p.orderId} confirmed without stock` }),
  VERIFY_BOT_IF_RISKY: noop, // task created synchronously
  QA_SAMPLE_POOL: noop, // TODO(phase 5)
  SET_NEXT_ACTION: noop, // done synchronously
  VERIFY_TASK: noop, // task created synchronously
  NOTIFY_DUPLICATE: noop, // the agent sees DOUBLE orders in the queue chips
  FINAL_UNREACHABLE_MESSAGE: (p) => sendTemplate(p, "injoignable_final"),
  PRINT_LABEL: noop, // TODO(phase 4)
  NOTIFY_STOCK_BACK: (p) => sendTemplate(p, "written_confirmation"),
  SEND_SHIPPED_MESSAGE: (p) => sendTemplate(p, "shipped"),
  // section 10.1: customer message per courier status (tasks were created synchronously)
  DELIVERY_TASK: async (p) => {
    const map: Record<string, string> = { ARRIVE_WILAYA: "arrived_wilaya", STOP_DESK: "stopdesk_info", EN_LIVRAISON: "delivery_day_amount", CLIENT_INJOIGNABLE_LIVREUR: "courier_trying_to_reach_you" };
    const tpl = map[p.to];
    if (tpl) await sendTemplate(p, tpl, (p.payload.messageVars as Record<string, string> | undefined) ?? {});
  },
  DELIVERED_STATS: (p) => sendTemplate(p, "did_you_receive"), // aggregates are computed by the KPI layer (phase 5)
  LINK_RETURN_TO_AGENT: noop, // confirmedById recorded in the event payload
  RESTOCK: noop, // TODO(phase 4)
  RELEASE_STOCK: noop, // TODO(phase 4)
  INVOICE_LINE: noop, // TODO(phase 6)
  OPEN_CLAIM: noop, // TODO(phase 4)
  MISSED_CALL_MESSAGE: async (p) => {
    // after the FIRST unanswered attempt of the first round only (section 8.2)
    const outcome = p.payload.outcome as string | undefined;
    if (outcome && outcome !== "ANSWERED" && Number(p.payload.attemptNo) === 1 && Number(p.payload.round ?? 0) === 0) await sendTemplate(p, "missed_call_1");
  },
  WRITE_BACK: async (p) => {
    const o = await orderContact(p.orderId);
    if (o) await enqueue("store.writeback", { orderId: p.orderId, storeId: o.storeId, event: "status", status: p.to }, { jobId: `wb:${p.orderId}:${p.to}:${Date.now()}` });
  },
  QUEUE_REFRESH: noop,
  AUTO_ASSIGN: async (p) => {
    await autoAssignOrder(p.orderId);
  },
  BOT_CONFIRM_REQUEST: async (p) => {
    const merchant = await withSystemContext("side-effects", () => prisma.organization.findUnique({ where: { id: p.merchantId }, select: { settings: true } }));
    const settings = (merchant?.settings ?? {}) as { messaging?: { botConfirmation?: boolean } };
    if (settings.messaging?.botConfirmation) await sendTemplate(p, "bot_confirm_request");
  },
};

export async function handleStatusChanged(job: Job<Payload>): Promise<void> {
  const p = job.data;
  for (const effect of p.sideEffects as SideEffect[]) {
    const h = handlers[effect];
    if (h) await h(p);
  }
  console.log(`[worker:events] order ${p.orderId} ${p.from ?? "∅"} → ${p.to} (${p.sideEffects.length} side effects)`);
}
