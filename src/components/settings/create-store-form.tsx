"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createStoreAction } from "@/app/[locale]/(app)/settings/stores/actions";

const CHANNELS = ["SHOPIFY", "DZBUILD", "GOOGLE_SHEET", "WOOCOMMERCE", "YOUCAN", "API", "MANUAL"];
const selectCls = "h-9 rounded-md border bg-background px-2 text-sm";

export function CreateStoreForm({ merchants }: { merchants: Array<{ id: string; name: string }> }) {
  const t = useTranslations("stores");
  const router = useRouter();
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? "");
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("SHOPIFY");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t("create")}</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        {merchants.length > 1 ? (
          <select className={selectCls} value={merchantId} onChange={(e) => setMerchantId(e.target.value)} aria-label="merchant">
            {merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : null}
        <Input className="w-64" placeholder={t("name")} value={name} onChange={(e) => setName(e.target.value)} />
        <select className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value)} aria-label={t("channel")}>
          {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Button disabled={pending || !name.trim()} onClick={() => start(async () => {
          const r = await createStoreAction({ merchantId, name, channel });
          if (r.ok && r.data) router.push(`/settings/stores/${r.data.id}`);
          else if (!r.ok) setError(r.message);
        })}>{t("createButton")}</Button>
        {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
