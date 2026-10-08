import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireContext } from "@/lib/auth/guards";
import { listOrders, orderFilterOptions, queueChips } from "@/lib/orders/repository";
import { parseOrderSearchParams, type SearchParams } from "@/lib/orders/searchParams";
import { isSupervisorPlus } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { QueueChips } from "@/components/orders/queue-chips";
import { OrderFilters } from "@/components/orders/order-filters";
import { OrdersTable } from "@/components/orders/orders-table";
import { toOrderRowDto } from "@/components/orders/dto";

export const metadata: Metadata = { title: "Orders" };

export default async function OrdersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> }) {
  const { locale } = await params;
  const sp = await searchParams;
  const ctx = await requireContext(locale);
  const t = await getTranslations("orders");
  const { filters, page, pageSize, sort } = parseOrderSearchParams(sp);

  const [result, chips, options] = await Promise.all([
    listOrders(ctx, filters, { page, pageSize, sort }),
    queueChips(ctx, { storeId: filters.storeId, merchantId: filters.merchantId, podId: filters.podId, assignedToId: filters.assignedToId }),
    orderFilterOptions(ctx),
  ]);

  const baseQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (k === "chip" || k === "page" || v === undefined) continue;
    baseQuery[k] = Array.isArray(v) ? v.join(",") : v;
  }
  const exportQuery = new URLSearchParams({ ...baseQuery, ...(filters.chip ? { chip: filters.chip } : {}) });
  const canBulk = isSupervisorPlus(ctx);

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("count", { count: result.total })} />
      <QueueChips chips={chips} active={filters.chip} locale={locale} baseQuery={baseQuery} />
      <OrderFilters
        options={{ stores: options.stores, merchants: options.merchants, agents: options.agents.filter((a) => a.role !== "SUPERVISOR"), pods: options.pods }}
        locale={locale}
        showMerchant={ctx.accessibleMerchantIds.length > 1}
      />
      <OrdersTable
        rows={result.rows.map(toOrderRowDto)}
        locale={locale}
        timezone={ctx.timezone}
        canBulk={canBulk}
        agents={options.agents.filter((a) => a.role === "CONFIRMATION_AGENT" || a.role === "FOLLOWUP_AGENT")}
        exportHref={`/api/orders/export?${exportQuery.toString()}`}
      />
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
