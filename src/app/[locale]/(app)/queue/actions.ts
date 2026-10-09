"use server";

import type { OrderStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { nextOrderForAgent } from "@/lib/calls/agentQueue";
import { addComment, proposeFakeOrder, releaseLock, transitionOrder, TransitionError } from "@/lib/orders/orderTransitions";
import { nextAttemptStatus } from "@/lib/orders/transitions";
import { isOrderStatus } from "@/lib/orders/statuses";
import { resolveUnmatchedLine } from "@/lib/ingest/pipeline";
import { releaseAgentOrders } from "@/lib/assign/rules";
import { ForbiddenError, orderAccessWhere } from "@/lib/tenant";

export type QueueActionResult = { ok: true; next?: string | null; message?: string } | { ok: false; code: string; message: string; detail?: string };

function fail(err: unknown): QueueActionResult {
  if (err instanceof TransitionError) return { ok: false, code: err.code, message: err.message, detail: err.message };
  if (err instanceof ForbiddenError) return { ok: false, code: "FORBIDDEN", message: err.message };
  console.error("[queue action]", err);
  return { ok: false, code: "UNKNOWN", message: (err as Error).message ?? "Unexpected error" };
}

/** Serve (and claim) the next order of the agent's queue. */
export async function nextOrderAction(): Promise<QueueActionResult & { kind?: string; nextAt?: string | null; reason?: string }> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    const r = await nextOrderForAgent(ctx);
    if (r.kind === "order") return { ok: true, next: r.orderId, kind: "order" };
    if (r.kind === "blocked") return { ok: true, next: null, kind: "blocked", reason: r.reason };
    return { ok: true, next: null, kind: "empty", nextAt: r.nextAt?.toISOString() ?? null };
  } catch (err) {
    return fail(err);
  }
}

/** Log the attempt just made from the call screen (APPEL_n derived from the counter). */
export async function logAttemptAction(input: { orderId: string; outcome: string; durationSec?: number; callbackAt?: string; note?: string; phoneNumberId?: string }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    const order = await prisma.order.findFirst({ where: { AND: [{ id: input.orderId }, orderAccessWhere(ctx)] }, select: { attemptCount: true } });
    if (!order) return { ok: false, code: "ORDER_NOT_FOUND", message: "Order not found" };
    await transitionOrder(ctx, {
      orderId: input.orderId,
      to: nextAttemptStatus(order.attemptCount),
      payload: {
        call: {
          outcome: input.outcome,
          // Phase 2: manual entry (flagged MANUAL_PROOF). Phase 3 replaces this with the telephony
          // adapter: the device / VoIP log arrives through /api/v1/calls and carries the proof.
          proof: "NONE",
          durationSec: input.durationSec,
          callbackAt: input.callbackAt ? new Date(input.callbackAt).toISOString() : undefined,
          note: input.note,
          phoneNumberId: input.phoneNumberId,
        },
      },
    });
    revalidatePath(`/${ctx.locale}/queue/${input.orderId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Confirm / postpone / cancel / to-verify / re-confirm from the call screen. */
export async function decisionAction(input: { orderId: string; to: string; payload: Record<string, unknown> }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  if (!isOrderStatus(input.to)) return { ok: false, code: "INVALID_PAYLOAD", message: "Unknown status" };
  try {
    await transitionOrder(ctx, { orderId: input.orderId, to: input.to as OrderStatus, payload: input.payload });
    revalidatePath(`/${ctx.locale}/queue`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function proposeFakeQueueAction(input: { orderId: string; fakeReason: string; note: string }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    await proposeFakeOrder(ctx, input);
    // the order leaves the agent's hands until the supervisor decides
    await releaseLock(ctx, input.orderId, "RELEASED").catch(() => null);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function skipAction(input: { orderId: string }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    await releaseLock(ctx, input.orderId, "SKIPPED");
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function commentAction(input: { orderId: string; body: string; tags: string[] }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    await addComment(ctx, input);
    revalidatePath(`/${ctx.locale}/queue/${input.orderId}`);
    revalidatePath(`/${ctx.locale}/orders/${input.orderId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function resolveUnmatchedAction(input: { lineId: string; productId: string; variantId?: string | null; orderId: string }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    await resolveUnmatchedLine(ctx, { lineId: input.lineId, productId: input.productId, variantId: input.variantId, remember: true });
    revalidatePath(`/${ctx.locale}/orders/${input.orderId}`);
    revalidatePath(`/${ctx.locale}/queue/${input.orderId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** Live availability toggle (section 9.1). Going OFFLINE during a shift releases open orders to the pool. */
export async function setAvailabilityAction(input: { availability: "AVAILABLE" | "BREAK" | "OFFLINE" }): Promise<QueueActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  await prisma.membership.update({ where: { userId_orgId: { userId: ctx.userId, orgId: ctx.orgId } }, data: { availability: input.availability } });
  let released = 0;
  if (input.availability === "OFFLINE" && ctx.role === "CONFIRMATION_AGENT") released = await releaseAgentOrders(ctx.userId, ctx.accessibleMerchantIds);
  revalidatePath("/", "layout");
  return { ok: true, message: String(released) };
}
