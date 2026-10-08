"use server";

import type { OrderStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit";
import { ForbiddenError, NotFoundError, isSupervisorPlus } from "@/lib/tenant";
import {
  addOrderNote,
  assignOrder,
  overrideOrderStatus,
  proposeFakeOrder,
  transitionOrder,
  TransitionError,
} from "@/lib/orders/orderTransitions";
import { isOrderStatus } from "@/lib/orders/statuses";

export type ActionResult = { ok: true; status?: OrderStatus } | { ok: false; code: string; message: string; detail?: string };

function mapError(err: unknown): ActionResult {
  if (err instanceof TransitionError) {
    const detail = typeof err.details === "object" && err.details && "requirement" in err.details ? err.message : undefined;
    return { ok: false, code: err.code, message: err.message, detail };
  }
  if (err instanceof ForbiddenError) return { ok: false, code: "FORBIDDEN", message: err.message };
  if (err instanceof NotFoundError) return { ok: false, code: "ORDER_NOT_FOUND", message: err.message };
  console.error("[orders action]", err);
  return { ok: false, code: "UNKNOWN", message: "Unexpected error" };
}

function revalidate(locale: string, orderId?: string) {
  revalidatePath(`/${locale}/orders`);
  revalidatePath(`/${locale}/dashboard`);
  if (orderId) revalidatePath(`/${locale}/orders/${orderId}`);
}

export async function transitionAction(input: { locale: string; orderId: string; to: string; payload?: unknown }): Promise<ActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  if (!isOrderStatus(input.to)) return { ok: false, code: "INVALID_PAYLOAD", message: "Unknown status" };
  try {
    const r = await transitionOrder(ctx, { orderId: input.orderId, to: input.to, payload: input.payload });
    revalidate(input.locale, input.orderId);
    return { ok: true, status: r.order.status };
  } catch (err) {
    return mapError(err);
  }
}

export async function overrideAction(input: { locale: string; orderId: string; to: string; reason: string }): Promise<ActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  if (!isOrderStatus(input.to)) return { ok: false, code: "INVALID_PAYLOAD", message: "Unknown status" };
  try {
    const r = await overrideOrderStatus(ctx, { orderId: input.orderId, to: input.to, reason: input.reason });
    revalidate(input.locale, input.orderId);
    return { ok: true, status: r.order.status };
  } catch (err) {
    return mapError(err);
  }
}

export async function assignAction(input: { locale: string; orderId: string; toUserId: string }): Promise<ActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    const r = await assignOrder(ctx, { orderId: input.orderId, toUserId: input.toUserId, rule: "MANUAL" });
    revalidate(input.locale, input.orderId);
    return { ok: true, status: r.order.status };
  } catch (err) {
    return mapError(err);
  }
}

export async function bulkReassignAction(input: { orderIds: string[]; toUserId: string }): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const ctx = await getCurrentContext();
  if (!ctx || !isSupervisorPlus(ctx)) return { ok: false, message: "Forbidden" };
  const ids = [...new Set(input.orderIds)].slice(0, 200);
  let count = 0;
  const failures: string[] = [];
  for (const orderId of ids) {
    try {
      await assignOrder(ctx, { orderId, toUserId: input.toUserId, rule: "BULK_MANUAL" });
      count++;
    } catch (err) {
      failures.push(`${orderId}: ${(err as Error).message}`);
    }
  }
  await writeAuditLog(ctx, { action: "ORDERS_BULK_REASSIGN", payload: { toUserId: input.toUserId, count, failures: failures.slice(0, 20) } });
  revalidatePath(`/${ctx.locale}/orders`);
  revalidatePath("/", "layout");
  return { ok: true, count };
}

export async function noteAction(input: { locale: string; orderId: string; note: string }): Promise<ActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    await addOrderNote(ctx, { orderId: input.orderId, note: input.note });
    revalidate(input.locale, input.orderId);
    return { ok: true };
  } catch (err) {
    return mapError(err);
  }
}

export async function proposeFakeAction(input: { locale: string; orderId: string; note: string }): Promise<ActionResult> {
  const ctx = await getCurrentContext();
  if (!ctx) return { ok: false, code: "FORBIDDEN", message: "Not signed in" };
  try {
    await proposeFakeOrder(ctx, { orderId: input.orderId, note: input.note });
    revalidate(input.locale, input.orderId);
    return { ok: true };
  } catch (err) {
    return mapError(err);
  }
}
