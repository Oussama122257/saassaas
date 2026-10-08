import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/errors";
import { cursorWhere, decodeCursor, page, parseLimit } from "@/lib/api/pagination";
import { serializeOrder } from "@/lib/api/serializers";
import { listOrdersCursor } from "@/lib/orders/repository";
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
