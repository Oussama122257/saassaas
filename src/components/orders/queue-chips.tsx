import { getTranslations } from "next-intl/server";
import type { OrderStatus } from "@prisma/client";
import { Link } from "@/i18n/navigation";
import type { QueueChips as Chips } from "@/lib/orders/repository";
import { CONFIRMATION_STATUSES, statusLabel } from "@/lib/orders/statuses";
import { cn } from "@/lib/utils";

/** Counters on the orders page (section 19b.2). Clicking a chip filters the table. */
export async function QueueChips({ chips, active, locale, baseQuery }: { chips: Chips; active?: string; locale: string; baseQuery: Record<string, string> }) {
  const t = await getTranslations("chips");
  const items: Array<{ key: string; label: string; count: number }> = [
    { key: "", label: t("all"), count: chips.total },
    { key: "NOT_TREATED", label: t("NOT_TREATED"), count: chips.notTreated },
    ...CONFIRMATION_STATUSES.filter((s) => s !== "NOUVEAU" && s !== "ASSIGNEE").map((s: OrderStatus) => ({ key: s, label: statusLabel(s, locale), count: chips.byStatus[s] ?? 0 })),
    { key: "RETURN_ON_WAY", label: t("RETURN_ON_WAY"), count: chips.returnOnWay },
    { key: "SHIPPED_NO_SCAN_24H", label: t("SHIPPED_NO_SCAN_24H"), count: chips.shippedNoScan24h },
  ];
  return (
    <div className="flex flex-wrap gap-2" data-testid="queue-chips">
      {items.map((item) => {
        const query: Record<string, string> = { ...baseQuery, page: "1" };
        if (item.key) query.chip = item.key;
        const isActive = (active ?? "") === item.key;
        return (
          <Link
            key={item.key || "all"}
            href={{ pathname: "/orders", query }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
              isActive ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
              item.count === 0 && !isActive ? "text-muted-foreground" : "",
            )}
          >
            <span>{item.label}</span>
            <span className={cn("rounded-full px-1.5 font-mono text-[11px]", isActive ? "bg-primary-foreground/20" : "bg-muted")}>{item.count}</span>
          </Link>
        );
      })}
    </div>
  );
}
