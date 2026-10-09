import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/errors";
import { cursorWhere, decodeCursor, page, parseLimit } from "@/lib/api/pagination";
import { serializeOrder } from "@/lib/api/serializers";
import { listOrdersCursor, orderListInclude, scopeOrderWhere } from "@/lib/orders/repository";
import { createOrderBody } from "@/lib/api/schemas";
import { ingestOrder } from "@/lib/ingest/pipeline";
import type { MappedOrder } from "@/lib/ingest/fieldMapping";
import { prisma, withSystemContext } from "@/lib/db";
import { isOrderStatus } from "@/lib/orders/statuses";
import type { OrderStatus } from "@prisma/client";

const querySchema = z.object({
  status: z.string().optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  customer_phone: z.string().optional(),
  store_id: z.string().optional(),
  merchant_id: z.string().optional(),
  q: z.string().optional(),
});

/** GET /v1/orders — cursor paginated, newest first. Scope: orders:read */
export const GET = apiHandler({ scope: "orders:read" }, async ({ req, key }) => {
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw ApiError.validation(parsed.error.issues);
  const q = parsed.data;

  const statuses = q.status
    ? q.status.split(",").map((s) => s.trim()).filter((s): s is OrderStatus => isOrderStatus(s))
    : undefined;
  if (q.status && (!statuses || statuses.length === 0)) throw ApiError.validation({ status: q.status }, "Unknown status code");

  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = decodeCursor(url.searchParams.get("cursor"));

  const rows = await listOrdersCursor(
    key,
    {
      status: statuses,
      from: q.since ? new Date(q.since) : undefined,
      to: q.until ? new Date(q.until) : undefined,
      q: q.customer_phone ?? q.q,
      storeId: q.store_id,
      merchantId: q.merchant_id,
    },
    { limit, cursorWhere: cursorWhere(cursor) },
  );
  const { items, nextCursor } = page(rows, limit);
  return { data: items.map(serializeOrder), meta: { limit, next_cursor: nextCursor } };
});

/**
 * POST /v1/orders — create an order through the ingestion pipeline. Scope: orders:write.
 * Idempotent per store on `external_id` (plus the Idempotency-Key header on every POST).
 */
export const POST = apiHandler({ scope: "orders:write" }, async ({ key, json }) => {
  const parsed = createOrderBody.safeParse(json());
  if (!parsed.success) throw ApiError.validation(parsed.error.issues);
  const b = parsed.data;
  const store = await withSystemContext("api-ingest", () => prisma.store.findFirst({ where: { id: b.store_id, merchantId: { in: key.accessibleMerchantIds }, active: true } }));
  if (!store) throw ApiError.notFound("Store");

  // product_id lines are resolved directly; sku/name lines go through SKU resolution
  const mapped: MappedOrder = {
    externalId: b.external_id ?? null,
    externalName: b.external_name ?? null,
    customerName: b.customer.name ?? null,
    phone: b.customer.phone,
    phone2: b.customer.phone2 ?? null,
    wilaya: String(b.shipping.wilaya),
    commune: b.shipping.commune ?? null,
    address: b.shipping.address ?? null,
    address2: b.shipping.address2 ?? null,
    landmark: b.shipping.landmark ?? null,
    deliveryType: b.shipping.delivery_type,
    shippingFee: b.shipping.free_delivery ? 0 : b.shipping.fee ?? null,
    total: b.total ?? null,
    note: b.note ?? null,
    source: b.source ?? "api",
    items: [],
    createdAt: null,
  };
  const byId = b.items.filter((i) => i.product_id);
  if (byId.length) {
    const products = await withSystemContext("api-ingest", () => prisma.product.findMany({ where: { merchantId: store.merchantId, id: { in: byId.map((i) => i.product_id!) } }, select: { id: true, sku: true, name: true } }));
    for (const i of byId) {
      const p = products.find((x) => x.id === i.product_id);
      if (!p) throw ApiError.validation({ product_id: i.product_id }, "Unknown product_id for this store");
      mapped.items.push({ productId: p.id, sku: p.sku ?? null, name: p.name, variant: i.variant ?? null, qty: i.qty, unitPrice: i.unit_price ?? null });
    }
  }
  for (const i of b.items.filter((x) => !x.product_id)) {
    if (!i.sku && !i.name) throw ApiError.validation({ item: i }, "Each item needs product_id, sku or name");
    mapped.items.push({ sku: i.sku ?? null, name: i.name ?? i.sku!, variant: i.variant ?? null, qty: i.qty, unitPrice: i.unit_price ?? null });
  }
  const result = await ingestOrder(store, mapped, { clientIp: b.client_ip, publicIntake: !!b.client_ip, source: b.source ?? "api", flags: b.abandoned_cart_recovery ? ["ABANDONED_CART"] : undefined });
  const full = await prisma.order.findFirst({ where: { AND: [scopeOrderWhere(key), { id: result.order.id }] }, include: orderListInclude });
  return { status: result.created ? 201 : 200, data: serializeOrder(full!), meta: { created: result.created } };
});
