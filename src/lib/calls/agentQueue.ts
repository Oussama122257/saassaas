import type { Order, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { claimOrder, loadOpsContext, lockedByOther } from "@/lib/orders/orderTransitions";
import { CLAIMABLE_STATUSES } from "@/lib/orders/statuses";
import type { TenantContext } from "@/lib/tenant";
import { blockedReason, type BlockReason } from "./slots";

/**
 * Agent queue (section 8.4): agents do not pick orders, the queue serves one at a time.
 * Priority: (1) callbacks / postponed / re-confirmations due, (2) never-called orders (oldest first,
 * time-to-first-call), (3) attempts due by nextActionAt. The served order is claimed (locked).
 */
export type NextOrderResult =
  | { kind: "order"; orderId: string; claimed: boolean }
  | { kind: "empty"; nextAt: Date | null }
  | { kind: "blocked"; reason: BlockReason; nextAt: Date | null };

function baseWhere(ctx: TenantContext, now: Date): Prisma.OrderWhereInput {
  return {
    assignedToId: ctx.userId,
    merchantId: { in: ctx.accessibleMerchantIds },
    deletedAt: null,
    OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }],
    AND: [{ OR: [{ lockedById: null }, { lockedById: ctx.userId }, { lockedAt: { lt: new Date(now.getTime() - 10 * 60_000) } }] }],
  };
}

export async function nextOrderForAgent(ctx: TenantContext, now = new Date()): Promise<NextOrderResult> {
  // already working on one
  const held = await prisma.order.findFirst({
    where: { status: "EN_COURS_CONFIRMATION", lockedById: ctx.userId, merchantId: { in: ctx.accessibleMerchantIds } },
    select: { id: true },
  });
  if (held) return { kind: "order", orderId: held.id, claimed: true };

  const where = baseWhere(ctx, now);
  const tiers: Prisma.OrderWhereInput[] = [
    { status: { in: ["REPORTE", "CONFIRMEE_REPORTEE"] } },
    { status: { in: CLAIMABLE_STATUSES }, flags: { hasSome: ["CALLBACK", "CALLBACK_DUE"] } },
    { status: "ASSIGNEE", attemptCount: 0 },
    { status: { in: CLAIMABLE_STATUSES } },
  ];
  let found: Pick<Order, "id" | "status" | "merchantId" | "podId" | "lockedById" | "lockedAt"> | null = null;
  for (const tier of tiers) {
    found = await prisma.order.findFirst({
      where: { AND: [where, tier] },
      orderBy: [{ nextActionAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      select: { id: true, status: true, merchantId: true, podId: true, lockedById: true, lockedAt: true },
    });
    if (found) break;
  }
  if (!found) {
    const upcoming = await prisma.order.findFirst({
      where: { assignedToId: ctx.userId, merchantId: { in: ctx.accessibleMerchantIds }, deletedAt: null, status: { in: [...CLAIMABLE_STATUSES, "CONFIRMEE_REPORTEE"] }, nextActionAt: { gt: now } },
      orderBy: { nextActionAt: "asc" },
      select: { nextActionAt: true },
    });
    return { kind: "empty", nextAt: upcoming?.nextActionAt ?? null };
  }

  const ops = await loadOpsContext(prisma, found);
  const blocked = blockedReason(now, ops.settings.calls, ops.timezone);
  if (blocked) return { kind: "blocked", reason: blocked, nextAt: null };
  if (lockedByOther(found, ctx.userId, ops.settings.lifecycle.lockTimeoutMin, now)) return { kind: "empty", nextAt: null };

  if (found.status === "CONFIRMEE_REPORTEE") return { kind: "order", orderId: found.id, claimed: false };
  await claimOrder(ctx, found.id);
  return { kind: "order", orderId: found.id, claimed: true };
}

export interface QueueStats {
  due: number;
  upcoming: number;
  callbacks: number;
  newOrders: number;
  doneToday: number;
}

export async function queueStats(ctx: TenantContext, since: Date, now = new Date()): Promise<QueueStats> {
  const mine: Prisma.OrderWhereInput = { assignedToId: ctx.userId, merchantId: { in: ctx.accessibleMerchantIds }, deletedAt: null };
  const [due, upcoming, callbacks, newOrders, doneToday] = await Promise.all([
    prisma.order.count({ where: { ...mine, status: { in: [...CLAIMABLE_STATUSES, "CONFIRMEE_REPORTEE", "EN_COURS_CONFIRMATION"] }, OR: [{ nextActionAt: null }, { nextActionAt: { lte: now } }] } }),
    prisma.order.count({ where: { ...mine, status: { in: [...CLAIMABLE_STATUSES, "CONFIRMEE_REPORTEE"] }, nextActionAt: { gt: now } } }),
    prisma.order.count({ where: { ...mine, flags: { hasSome: ["CALLBACK", "CALLBACK_DUE"] } } }),
    prisma.order.count({ where: { ...mine, status: "ASSIGNEE", attemptCount: 0 } }),
    prisma.callAttempt.count({ where: { agentId: ctx.userId, startedAt: { gte: since }, order: { merchantId: { in: ctx.accessibleMerchantIds } } } }),
  ]);
  return { due, upcoming, callbacks, newOrders, doneToday };
}
