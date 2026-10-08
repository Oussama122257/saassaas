"use client";

import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

export function Pagination({ page, pageSize, total, pageSizes = [20, 50, 100] }: { page: number; pageSize: number; total: number; pageSizes?: readonly number[] }) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const go = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2">
        <label htmlFor="pageSize" className="text-muted-foreground">
          {t("rowsPerPage")}
        </label>
        <select
          id="pageSize"
          className="h-8 rounded-md border bg-background px-2"
          value={pageSize}
          onChange={(e) => go({ pageSize: e.target.value, page: "1" })}
        >
          {pageSizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{t("page", { page, pages })}</span>
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => go({ page: String(page - 1) })}>
          ‹
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => go({ page: String(page + 1) })}>
          ›
        </Button>
      </div>
    </div>
  );
}
