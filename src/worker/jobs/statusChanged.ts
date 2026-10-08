import type { Job } from "bullmq";
import type { JobPayloads } from "@/lib/queue";
import type { SideEffect } from "@/lib/orders/transitions";

/**
 * Runs the side effects attached to a status change. Each handler is idempotent (the job id is
 * derived from the OrderEvent id, so a replayed event is a no-op). Handlers that need an external
 * system are stubs until the phase that owns them lands:
 *   phase 2: SCHEDULE_NEXT_ATTEMPT, SET_NEXT_ACTION, NOTIFY_DUPLICATE
 *   phase 3: SEND_WRITTEN_CONFIRMATION, FINAL_UNREACHABLE_MESSAGE, SEND_SHIPPED_MESSAGE, NOTIFY_STOCK_BACK
 *   phase 4: RESERVE_STOCK, RELEASE_STOCK, RESTOCK, PRINT_LABEL, DELIVERY_TASK (messaging part), OPEN_CLAIM
 *   phase 5: QA_SAMPLE_POOL, DELIVERED_STATS
 *   phase 6: INVOICE_LINE
 */
type Payload = JobPayloads["order.status_changed"];

const handlers: Record<SideEffect, (p: Payload) => Promise<void>> = {
  SCHEDULE_NEXT_ATTEMPT: async () => undefined, // TODO(phase 2): call scheduler computes nextActionAt from slots
  SEND_WRITTEN_CONFIRMATION: async () => undefined, // TODO(phase 3): WhatsApp template written_confirmation
  RESERVE_STOCK: async () => undefined, // TODO(phase 4): StockItem.reserved += qty
  HANDOFF_TO_FOLLOWUP: async () => undefined, // done synchronously in applyRule; nothing to do
  WAITING_STOCK_TASK: async () => undefined, // task created synchronously
  NOTIFY_SUPERVISOR: async () => undefined, // TODO(phase 2): in-app notification
  VERIFY_BOT_IF_RISKY: async () => undefined, // task created synchronously
  QA_SAMPLE_POOL: async () => undefined, // TODO(phase 5)
  SET_NEXT_ACTION: async () => undefined, // done synchronously
  VERIFY_TASK: async () => undefined, // task created synchronously
  NOTIFY_DUPLICATE: async () => undefined, // TODO(phase 2): notify the agent to verify with the customer
  FINAL_UNREACHABLE_MESSAGE: async () => undefined, // TODO(phase 3): WhatsApp/SMS injoignable_final
  PRINT_LABEL: async () => undefined, // TODO(phase 4)
  NOTIFY_STOCK_BACK: async () => undefined, // TODO(phase 3/4)
  SEND_SHIPPED_MESSAGE: async () => undefined, // TODO(phase 3): template shipped
  DELIVERY_TASK: async () => undefined, // task created synchronously; messaging in phase 3
  DELIVERED_STATS: async () => undefined, // TODO(phase 5): daily aggregates + bonus credit
  LINK_RETURN_TO_AGENT: async () => undefined, // confirmedById recorded in the event payload
  RESTOCK: async () => undefined, // TODO(phase 4)
  RELEASE_STOCK: async () => undefined, // TODO(phase 4)
  INVOICE_LINE: async () => undefined, // TODO(phase 6)
  OPEN_CLAIM: async () => undefined, // TODO(phase 4)
};

export async function handleStatusChanged(job: Job<Payload>): Promise<void> {
  const p = job.data;
  for (const effect of p.sideEffects as SideEffect[]) {
    const h = handlers[effect];
    if (h) await h(p);
  }
  console.log(`[worker:events] order ${p.orderId} ${p.from ?? "∅"} → ${p.to} (${p.sideEffects.length} side effects)`);
}
