import type { OrderStatus, Prisma, StatusGroup } from "@prisma/client";
import { prisma } from "@/lib/db";
import { orderAccessWhere, tenantWhere, type TenantContext } from "@/lib/tenant";
import type { ApiKeyContext } from "@/lib/api/keys";
import { normalizePhone } from "@/lib/phone";
import { addHours } from "@/lib/time";
import { CONFIRMATION_STATUSES } from "./statuses";

/**
 * Read side for orders. Every function takes a scope (signed-in user or API key) and adds the
 * tenant filter; nothing here can be called without one.
 */
export type ReadScope = TenantContext | ApiKeyContext;

export function scopeOrderWhere(scope: ReadScope): Prisma.OrderWhereInput {
  if (scope.kind === "user") return orderAccessWhere(scope);
  return { merchantId: { in: scope.accessibleMerchantIds } };
}

export interface OrderFilters {
  q?: string;
  status?: OrderStatus[];
  statusGroup?: StatusGroup;
  storeId?: string;
  merchantId?: string;
  assignedToId?: string;
  podId?: string;
  wilayaCode?: number;
  courierId?: string;
  productId?: string;
  from?: Date;
  to?: Date;
  /** named chips (section 19b.2) */
  chip?: ChipKey;
}

export type ChipKey = "NOT_TREATED" | "RETURN_ON_WAY" | "SHIPPED_NO_SCAN_24H" | OrderStatus;

export function chipWhere(chip: ChipKey, now = new Date()): Prisma.OrderWhereInput {
  switch (chip) {
    case "NOT_TREATED":
      return { status: { in: ["NOUVEAU", "ASSIGNEE"] } };
    case "RETURN_ON_WAY":
      return { status: "RETOUR_EN_COURS" };
    case "SHIPPED_NO_SCAN_24H":
      return {
        status: "EXPEDIE",
        shippedAt: { lt: addHours(now, -24) },
        OR: [{ lastCourierSyncAt: null }, { lastCourierSyncAt: { lt: addHours(now, -24) } }],
      };
    default:
      return { status: chip };
  }
}

export function buildOrderWhere(scope: ReadScope, f: OrderFilters, now = new Date()): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [scopeOrderWhere(scope)];
  if (f.merchantId) and.push({ merchantId: f.merchantId });
  if (f.status && f.status.length > 0) and.push({ status: { in: f.status } });
  if (f.statusGroup) and.push({ statusGroup: f.statusGroup });
  if (f.storeId) and.push({ storeId: f.storeId });
  if (f.assignedToId) and.push({ assignedToId: f.assignedToId });
  if (f.podId) and.push({ podId: f.podId });
  if (f.wilayaCode) and.push({ wilayaCode: f.wilayaCode });
  if (f.courierId) and.push({ courierId: f.courierId });
  if (f.productId) and.push({ items: { some: { productId: f.productId } } });
  if (f.from) and.push({ createdAt: { gte: f.from } });
  if (f.to) and.push({ createdAt: { lte: f.to } });
  if (f.chip) and.push(chipWhere(f.chip, now));
  if (f.q && f.q.trim()) {
    const q = f.q.trim();
    const or: Prisma.OrderWhereInput[] = [];
    const phone = normalizePhone(q);
    if (phone.phone && /\d{6,}/.test(q.replace(/\D/g, ""))) {
      or.push({ customerPhone: { contains: phone.phone.slice(-8) } }, { customerPhone2: { contains: phone.phone.slice(-8) } });
    }
    const seq = q.replace(/^#/, "");
    if (/^\d{1,9}$/.test(seq)) or.push({ seq: Number(seq) });
    or.push({ id: q }, { externalId: { contains: q, mode: "insensitive" } }, { trackingNumber: { equals: q, mode: "insensitive" } });
    or.push({ customerName: { contains: q, mode: "insensitive" } });
    and.push({ OR: or });
  }
  return { AND: and };
}

export const orderListInclude = {
  store: { select: { id: true, name: true, channel: true } },
  assignedTo: { select: { id: true, name: true } },
  confirmedBy: { select: { id: true, name: true } },
  pod: { select: { id: true, name: true } },
  courier: { select: { id: true, name: true, provider: true } },
  items: { include: { product: { select: { id: true, name: true } }, variant: { select: { id: true, name: true } } } },
} satisfies Prisma.OrderInclude;

export type OrderListRow = Prisma.OrderGetPayload<{ include: typeof orderListInclude }>;

export type OrderSort = "createdAt_desc" | "createdAt_asc" | "total_desc" | "total_asc" | "lastActivityAt_desc" | "seq_desc" | "seq_asc";

function orderBy(sort: OrderSort): Prisma.OrderOrderByWithRelationInput[] {
  switch (sort) {
    case "createdAt_asc":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "total_desc":
      return [{ total: "desc" }, { id: "desc" }];
    case "total_asc":
      return [{ total: "asc" }, { id: "asc" }];
    case "lastActivityAt_desc":
      return [{ lastActivityAt: "desc" }, { id: "desc" }];
    case "seq_desc":
      return [{ seq: "desc" }];
    case "seq_asc":
      return [{ seq: "asc" }];
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

export const PAGE_SIZES = [20, 50, 100] as const;

export async function listOrders(
  scope: ReadScope,
  filters: OrderFilters,
  opts: { page?: number; pageSize?: number; sort?: OrderSort } = {},
): Promise<{ rows: OrderListRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = PAGE_SIZES.includes((opts.pageSize ?? 50) as (typeof PAGE_SIZES)[number]) ? (opts.pageSize ?? 50) : 50;
  const page = Math.max(1, opts.page ?? 1);
  const where = buildOrderWhere(scope, filters);
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderListInclude, orderBy: orderBy(opts.sort ?? "createdAt_desc"), skip: (page - 1) * pageSize, take: pageSize }),
    prisma.order.count({ where }),
  ]);
  return { rows, total, page, pageSize };
}

/** Cursor-based listing for the public API (createdAt desc, id desc). */
export async function listOrdersCursor(
  scope: ReadScope,
  filters: OrderFilters,
  opts: { limit: number; cursorWhere: Prisma.OrderWhereInput },
): Promise<OrderListRow[]> {
  const where: Prisma.OrderWhereInput = { AND: [buildOrderWhere(scope, filters), opts.cursorWhere] };
  return prisma.order.findMany({ where, include: orderListInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.limit + 1 });
}

export const orderDetailInclude = {
  ...orderListInclude,
  merchant: { select: { id: true, name: true, timezone: true, locale: true } },
  customer: true,
  duplicateOf: { select: { id: true, seq: true, status: true, createdAt: true } },
  events: { include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
  calls: { include: { agent: { select: { id: true, name: true } }, phoneNumber: { select: { label: true, msisdn: true } } }, orderBy: { startedAt: "asc" } },
  courierEvents: { orderBy: { receivedAt: "desc" }, take: 50 },
  tasks: { include: { assignee: { select: { id: true, name: true } } }, orderBy: { dueAt: "asc" } },
  messages: { orderBy: { sentAt: "desc" }, take: 50 },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

export async function getOrderDetail(scope: ReadScope, orderId: string): Promise<OrderDetail | null> {
  return prisma.order.findFirst({ where: { AND: [{ id: orderId }, scopeOrderWhere(scope)] }, include: orderDetailInclude });
}

/** Previous orders of the same phone (customer history on the call screen and order detail). */
export async function customerHistory(scope: ReadScope, merchantId: string, phone: string, excludeOrderId?: string) {
  return prisma.order.findMany({
    where: {
      AND: [
        { merchantId: { in: scope.accessibleMerchantIds } },
        { merchantId, customerPhone: phone, ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}) },
      ],
    },
    select: { id: true, seq: true, status: true, total: true, createdAt: true, deliveredAt: true, returnReason: true, cancelReason: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

export interface QueueChips {
  notTreated: number;
  byStatus: Partial<Record<OrderStatus, number>>;
  returnOnWay: number;
  shippedNoScan24h: number;
  total: number;
}

export async function queueChips(scope: ReadScope, base: Pick<OrderFilters, "storeId" | "merchantId" | "podId" | "assignedToId"> = {}): Promise<QueueChips> {
  const where = buildOrderWhere(scope, base);
  const [grouped, returnOnWay, shippedNoScan24h, total] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], where: { AND: [where, { status: { in: CONFIRMATION_STATUSES } }] }, _count: { _all: true } }),
    prisma.order.count({ where: { AND: [where, chipWhere("RETURN_ON_WAY")] } }),
    prisma.order.count({ where: { AND: [where, chipWhere("SHIPPED_NO_SCAN_24H")] } }),
    prisma.order.count({ where }),
  ]);
  const byStatus: Partial<Record<OrderStatus, number>> = {};
  for (const g of grouped) byStatus[g.status] = g._count._all;
  return {
    notTreated: (byStatus.NOUVEAU ?? 0) + (byStatus.ASSIGNEE ?? 0),
    byStatus,
    returnOnWay,
    shippedNoScan24h,
    total,
  };
}

export async function orderFilterOptions(ctx: TenantContext) {
  const [stores, merchants, agents, pods] = await Promise.all([
    prisma.store.findMany({ where: tenantWhere(ctx), select: { id: true, name: true, merchantId: true }, orderBy: { name: "asc" } }),
    prisma.organization.findMany({ where: { id: { in: ctx.accessibleMerchantIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.membership.findMany({
      where: { orgId: ctx.orgId, active: true, role: { in: ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR"] } },
      select: { userId: true, role: true, podId: true, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.pod.findMany({ where: { orgId: ctx.orgId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    stores,
    merchants,
    agents: agents.map((a) => ({ id: a.userId, name: a.user.name, role: a.role, podId: a.podId })),
    pods,
  };
}

/** CSV export (section 16 bulk actions). Phones are masked for client viewers (section 21). */
export function ordersToCsv(rows: OrderListRow[], opts: { maskPhones: boolean; locale: string }): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["seq", "id", "created_at", "status", "store", "customer_name", "phone", "wilaya", "commune", "address", "delivery_type", "items", "subtotal", "shipping_fee", "total", "assigned_to", "confirmed_by", "courier", "tracking", "source"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const phone = opts.maskPhones ? `${r.customerPhone.slice(0, 2)}******${r.customerPhone.slice(-2)}` : r.customerPhone;
    lines.push(
      [
        r.seq,
        r.id,
        r.createdAt.toISOString(),
        r.status,
        r.store.name,
        r.customerName ?? "",
        phone,
        r.wilayaCode,
        r.commune ?? "",
        r.address ?? "",
        r.deliveryType,
        r.items.map((i) => `${i.qty}x ${i.product.name}${i.variant ? ` (${i.variant.name})` : ""}`).join(" | "),
        r.subtotal,
        r.shippingFee,
        r.total,
        r.assignedTo?.name ?? "",
        r.confirmedBy?.name ?? "",
        r.courier?.name ?? "",
        r.trackingNumber ?? "",
        r.source ?? "",
      ]
        .map(esc)
        .join(","),
    );
  }
  return `﻿${lines.join("\n")}`;
}

// ─────────────────────────────── audit log reads ───────────────────────────────

export interface AuditFilters {
  actorId?: string;
  type?: string;
  from?: Date;
  to?: Date;
  orderId?: string;
}

export async function listOrderEvents(ctx: TenantContext, f: AuditFilters, opts: { page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(1, opts.page ?? 1);
  const where: Prisma.OrderEventWhereInput = {
    order: orderAccessWhere(ctx),
    ...(f.actorId ? { actorId: f.actorId === "SYSTEM" ? null : f.actorId } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.orderId ? { orderId: f.orderId } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.orderEvent.findMany({
      where,
      include: { actor: { select: { id: true, name: true } }, order: { select: { id: true, seq: true, merchantId: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.orderEvent.count({ where }),
  ]);
  return { rows, total, page, pageSize };
}

export async function listAuditLogs(ctx: TenantContext, f: AuditFilters, opts: { page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(1, opts.page ?? 1);
  const where: Prisma.AuditLogWhereInput = {
    orgId: ctx.orgId,
    ...(f.actorId ? { actorId: f.actorId === "SYSTEM" ? null : f.actorId } : {}),
    ...(f.type ? { action: f.type } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({ where, include: { actor: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditLog.count({ where }),
  ]);
  return { rows, total, page, pageSize };
}

export async function orgMembers(ctx: TenantContext) {
  return prisma.membership.findMany({
    where: { orgId: ctx.orgId },
    select: { userId: true, role: true, active: true, podId: true, user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
}
