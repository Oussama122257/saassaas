"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { previewMappingAction, saveMappingAction, type PreviewRow } from "@/app/[locale]/(app)/settings/stores/actions";

const FIELDS = ["externalId", "externalName", "customerName", "phone", "phone2", "wilaya", "commune", "address", "address2", "landmark", "deliveryType", "shippingFee", "total", "note", "source", "items", "itemSku", "itemName", "itemVariant", "itemQty", "itemPrice", "createdAt"];

/** Per-store field mapping (source path → our field) with a live preview on the last 5 orders (sections 12.5, 19c.5). */
export function FieldMappingEditor({ storeId, channel, defaults, current }: { storeId: string; channel: string; defaults: Record<string, string>; current: Record<string, string> }) {
  const t = useTranslations("stores");
  const [map, setMap] = useState<Record<string, string>>(current);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (channel === "MANUAL") return null;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t("mapping")}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("mappingHelp")}</p>
        <div className="grid gap-2 md:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f} className="grid grid-cols-3 items-center gap-2">
              <span className="font-mono text-xs">{f}</span>
              <Input className="col-span-2 h-8 font-mono text-xs" dir="ltr" placeholder={defaults[f] ?? ""} value={map[f] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value }))} />
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={pending} onClick={() => start(async () => { const r = await previewMappingAction({ storeId, mapping: { ...defaults, ...map } }); if (r.ok) setPreview(r.data ?? []); else setMsg(r.message); })}>{t("preview")}</Button>
          <Button disabled={pending} onClick={() => start(async () => { const r = await saveMappingAction({ storeId, mapping: map }); setMsg(r.ok ? t("saved") : r.message); })}>{t("saveMapping")}</Button>
        </div>
        {msg ? <p className="text-muted-foreground">{msg}</p> : null}
        {preview ? (
          preview.length === 0 ? <p className="text-muted-foreground">{t("noPayloads")}</p> : (
            <div className="space-y-2" data-testid="mapping-preview">
              {preview.map((p, i) => (
                <div key={i} className="rounded-md border p-2 text-xs">
                  <div className="mb-1 flex flex-wrap items-center gap-1 text-muted-foreground">{p.source} {p.problems.map((x) => <Badge key={x} variant="destructive" className="text-[10px]">{x}</Badge>)}{p.problems.length === 0 ? <Badge variant="secondary">OK</Badge> : null}</div>
                  <div className="grid grid-cols-2 gap-x-4 md:grid-cols-4" dir="ltr">
                    <span>name: {p.mapped.customerName}</span><span>phone: {p.mapped.phone}</span><span>wilaya: {p.mapped.wilaya}</span><span>commune: {p.mapped.commune}</span>
                    <span>address: {p.mapped.address}</span><span>total: {p.mapped.total}</span><span>fee: {p.mapped.shippingFee}</span><span>type: {p.mapped.deliveryType}</span>
                    <span className="col-span-full">items: {p.mapped.items.map((it) => `${it.qty}× ${it.name}${it.variant ? ` (${it.variant})` : ""}${it.sku ? ` [${it.sku}]` : ""}`).join(", ")}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}
