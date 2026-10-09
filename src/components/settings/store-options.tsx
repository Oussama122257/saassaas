"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { saveStoreSettingsAction } from "@/app/[locale]/(app)/settings/stores/actions";

type WriteBack = { tags?: boolean; cancel?: boolean; status?: boolean; note?: boolean; fulfill?: boolean; markPaid?: boolean };

/** Per-store write-back toggles (sections 12.5 / 12.7) and backfill window. */
export function StoreOptions({ storeId, channel, writeBack, backfillDays, active }: { storeId: string; channel: string; writeBack: WriteBack; backfillDays: number; active: boolean }) {
  const t = useTranslations("stores");
  const [wb, setWb] = useState<WriteBack>({ tags: true, status: true, fulfill: true, cancel: false, markPaid: false, ...writeBack });
  const [days, setDays] = useState(backfillDays);
  const [isActive, setActive] = useState(active);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const keys: Array<keyof WriteBack> = channel === "SHOPIFY" ? ["tags", "cancel", "fulfill", "markPaid"] : channel === "DZBUILD" ? ["status", "cancel"] : [];
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t("options")}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {keys.map((k) => (
          <label key={k} className="flex items-center gap-2"><Checkbox checked={!!wb[k]} onCheckedChange={(v) => setWb((x) => ({ ...x, [k]: !!v }))} /> {t(`writeBack.${k}`)}</label>
        ))}
        {channel === "SHOPIFY" ? <label className="flex items-center gap-2">{t("backfillDays")} <Input type="number" className="w-24" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label> : null}
        <label className="flex items-center gap-2"><Checkbox checked={isActive} onCheckedChange={(v) => setActive(!!v)} /> {t("active")}</label>
        <Button disabled={pending} onClick={() => start(async () => { const r = await saveStoreSettingsAction({ storeId, writeBack: wb, backfillDays: days, active: isActive }); setMsg(r.ok ? t("saved") : r.message); })}>{t("save")}</Button>
        {msg ? <p className="text-muted-foreground">{msg}</p> : null}
      </CardContent>
    </Card>
  );
}
