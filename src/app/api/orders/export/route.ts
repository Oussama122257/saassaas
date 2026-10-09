import type { NextRequest } from "next/server";
import { getCurrentContext } from "@/lib/auth/session";
import { listOrders, ordersToRows, buildOrderWhere, orderListInclude } from "@/lib/orders/repository";
import { toCsv, toSpreadsheetXml } from "@/lib/csv";
import { parseOrderSearchParams } from "@/lib/orders/searchParams";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";

/** Session-authenticated CSV export of the current filter (or of selected ids). Logged in the audit log. */
export async function GET(req: NextRequest) {
  const ctx = await getCurrentContext();
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const sp: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  const { filters } = parseOrderSearchParams(sp);
  const ids = sp.ids ? sp.ids.split(",").filter(Boolean).slice(0, 1000) : null;

  const rows = ids
    ? await prisma.order.findMany({ where: { AND: [buildOrderWhere(ctx, filters), { id: { in: ids } }] }, include: orderListInclude, orderBy: { createdAt: "desc" } })
    : (await listOrders(ctx, filters, { page: 1, pageSize: 100 })).rows.concat(
        // export up to 5000 rows beyond the first page
        await prisma.order.findMany({ where: buildOrderWhere(ctx, filters), include: orderListInclude, orderBy: { createdAt: "desc" }, skip: 100, take: 4900 }),
      );

  const maskPhones = ctx.role === "CLIENT_VIEWER" || ctx.role === "MARKETER" || ctx.role === "READ_ONLY";
  const table = ordersToRows(rows, { maskPhones });
  const excel = sp.format === "xls";
  await writeAuditLog(ctx, { action: "ORDERS_EXPORT", payload: { count: rows.length, format: excel ? "xls" : "csv", filters: JSON.parse(JSON.stringify(filters)), ids: ids?.length ?? null } });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(excel ? toSpreadsheetXml("Orders", table) : toCsv(table), {
    headers: {
      "Content-Type": excel ? "application/vnd.ms-excel; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${day}.${excel ? "xls" : "csv"}"`,
      "Cache-Control": "no-store",
    },
  });
}
