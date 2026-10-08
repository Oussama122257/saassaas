import { apiHandler } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/errors";
import { serializeOrder } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";
import { orderListInclude, scopeOrderWhere } from "@/lib/orders/repository";

/** GET /v1/orders/{id} — by internal id or by per-merchant sequence (`seq:123` with merchant scope). Scope: orders:read */
export const GET = apiHandler<{ id: string }>({ scope: "orders:read" }, async ({ key, params }) => {
  const idOrSeq = params.id;
  const seqMatch = idOrSeq.match(/^seq:(\d+)$/);
  const order = await prisma.order.findFirst({
    where: { AND: [scopeOrderWhere(key), seqMatch ? { seq: Number(seqMatch[1]) } : { id: idOrSeq }] },
    include: orderListInclude,
  });
  if (!order) throw ApiError.notFound("Order");
  return { data: serializeOrder(order) };
});
