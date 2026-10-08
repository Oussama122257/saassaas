import type { OrderStatus } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { STATUS_META, statusLabel, type LabelOverrides } from "@/lib/orders/statuses";
import { cn } from "@/lib/utils";

const TONES: Record<(typeof STATUS_META)[OrderStatus]["tone"], string> = {
  neutral: "bg-muted text-foreground border-transparent",
  info: "bg-sky-100 text-sky-900 border-transparent dark:bg-sky-950 dark:text-sky-200",
  warning: "bg-amber-100 text-amber-900 border-transparent dark:bg-amber-950 dark:text-amber-200",
  success: "bg-emerald-100 text-emerald-900 border-transparent dark:bg-emerald-950 dark:text-emerald-200",
  danger: "bg-rose-100 text-rose-900 border-transparent dark:bg-rose-950 dark:text-rose-200",
  violet: "bg-violet-100 text-violet-900 border-transparent dark:bg-violet-950 dark:text-violet-200",
};

export function StatusBadge({ status, locale, overrides, className }: { status: OrderStatus; locale: string; overrides?: LabelOverrides; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap font-medium", TONES[meta.tone], className)} data-status={status}>
      {statusLabel(status, locale, overrides)}
    </Badge>
  );
}
