"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Input } from "@/components/ui/input";

export function AuditFilters({ members, types, tab }: { members: Array<{ id: string; name: string }>; types: string[]; tab: string }) {
  const t = useTranslations("audit");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", tab);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.set("page", "1");
    router.push(`${pathname}?${next.toString()}`);
  };
  const v = (k: string) => params.get(k) ?? "";
  const cls = "h-9 rounded-md border bg-background px-2 text-sm";
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="audit-filters">
      <select className={cls} value={v("actor")} onChange={(e) => set({ actor: e.target.value || undefined })} aria-label={t("member")}>
        <option value="">{t("member")}: {tc("all")}</option>
        <option value="SYSTEM">{tc("system")}</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
      <select className={cls} value={v("type")} onChange={(e) => set({ type: e.target.value || undefined })} aria-label={t("actionType")}>
        <option value="">{t("actionType")}: {tc("all")}</option>
        {types.map((x) => (
          <option key={x} value={x}>{x}</option>
        ))}
      </select>
      <Input type="date" className="w-40" value={v("from")} onChange={(e) => set({ from: e.target.value || undefined })} aria-label={tc("from")} />
      <Input type="date" className="w-40" value={v("to")} onChange={(e) => set({ to: e.target.value || undefined })} aria-label={tc("to")} />
    </div>
  );
}
