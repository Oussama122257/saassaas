import type { Order, OrderEvent } from "@prisma/client";
import { enqueue } from "@/lib/queue";
import type { ActorContext } from "@/lib/tenant";
import type { SideEffect } from "./transitions";

/**
 * Side effects run AFTER the transaction committed. Anything that talks to the outside world
 * (WhatsApp, courier, Shopify, stock jobs) is enqueued and executed by the worker so a failure
 * never rolls back a legitimate status change. Phase 1 ships the dispatch plumbing; the worker
 * handlers that do the real work arrive with the phase that owns them (see src/worker/jobs).
 */
export async function dispatchSideEffects(params: {
  ctx: ActorContext;
  order: Order;
  event: OrderEvent;
  sideEffects: readonly SideEffect[];
  payload: Record<string, unknown>;
}): Promise<void> {
  const { ctx, order, event, sideEffects, payload } = params;
  await enqueue(
    "order.status_changed",
    {
      orderId: order.id,
      merchantId: order.merchantId,
      from: event.fromStatus,
      to: event.toStatus ?? order.status,
      actorId: ctx.kind === "user" ? ctx.userId : null,
      sideEffects: [...sideEffects],
      payload,
    },
    { jobId: `status:${event.id}` },
  );
}
