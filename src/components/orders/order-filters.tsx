"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { OrderStatus } from "@prisma/client";
import { ALL_STATUSES, STATUS_GROUPS, STATUS_META, groupLabel, statusLabel } from "@/lib/orders/statuses";
import { WILAYAS } from "@/lib/wilayas";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface FilterOptions {
  stores: Array<{ id: string; name: string }>;
  merchants: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  pods: Array<{ id: string; name: string }>;
}

export function OrderFilters({ options, locale, showMerchant }: { options: FilterOptions; locale: string; showMerchant: boolean }) {
  const t = useTranslations("orders");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.set("page", "1");
    router.push(`${pathname}?${next.toString()}`);
  };
  const v = (k: string) => params.get(k) ?? "";
  const selectCls = "h-9 rounded-md border bg-background px-2 text-sm";

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-testid="order-filters"
      onSubmit={(e) => {
        e.preventDefault();
        const q = new FormData(e.currentTarget).get("q");
        set({ q: q ? String(q) : undefined });
      }}
    >
      <div className="min-w-64 flex-1">
        <Input name="q" placeholder={t("searchPlaceholder")} defaultValue={v("q")} aria-label={tc("search")} />
      </div>
      <select className={selectCls} value={v("status")} onChange={(e) => set({ status: e.target.value || undefined, group: undefined, chip: undefined })} aria-label={t("status")}>
        <option value="">{t("status")}: {tc("all")}</option>
        {STATUS_GROUPS.map((g) => (
          <optgroup key={g} label={groupLabel(g, locale)}>
            {ALL_STATUSES.filter((s: OrderStatus) => STATUS_META[s].group === g).map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s, locale)}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <select className={selectCls} value={v("group")} onChange={(e) => set({ group: e.target.value || undefined, status: undefined, chip: undefined })} aria-label={t("group")}>
        <option value="">{t("group")}: {tc("all")}</option>
        {STATUS_GROUPS.map((g) => (
          <option key={g} value={g}>
            {groupLabel(g, locale)}
          </option>
        ))}
      </select>
      {showMerchant ? (
        <select className={selectCls} value={v("merchant")} onChange={(e) => set({ merchant: e.target.value || undefined, store: undefined })} aria-label={t("merchant")}>
          <option value="">{t("merchant")}: {tc("all")}</option>
          {options.merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      ) : null}
      <select className={selectCls} value={v("store")} onChange={(e) => set({ store: e.target.value || undefined })} aria-label={t("store")}>
        <option value="">{t("store")}: {tc("all")}</option>
        {options.stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {options.agents.length > 0 ? (
        <select className={selectCls} value={v("agent")} onChange={(e) => set({ agent: e.target.value || undefined })} aria-label={t("agent")}>
          <option value="">{t("agent")}: {tc("all")}</option>
          {options.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : null}
      {options.pods.length > 0 ? (
        <select className={selectCls} value={v("pod")} onChange={(e) => set({ pod: e.target.value || undefined })} aria-label={t("pod")}>
          <option value="">{t("pod")}: {tc("all")}</option>
          {options.pods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : null}
      <select className={selectCls} value={v("wilaya")} onChange={(e) => set({ wilaya: e.target.value || undefined })} aria-label={t("wilaya")}>
        <option value="">{t("wilaya")}: {tc("all")}</option>
        {WILAYAS.map((w) => (
          <option key={w.code} value={w.code}>
            {String(w.code).padStart(2, "0")} – {locale.startsWith("ar") ? w.nameAr : w.nameFr}
          </option>
        ))}
      </select>
      <Input type="date" className="w-40" value={v("from")} onChange={(e) => set({ from: e.target.value || undefined })} aria-label={tc("from")} />
      <Input type="date" className="w-40" value={v("to")} onChange={(e) => set({ to: e.target.value || undefined })} aria-label={tc("to")} />
      <Button type="submit" variant="secondary" size="sm">
        {tc("search")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => router.push(pathname)}>
        {t("clearFilters")}
      </Button>
    </form>
  );
}
