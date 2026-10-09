"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { importOrdersAction, type ImportResult } from "@/app/[locale]/(app)/orders/manual-actions";

const TEMPLATE = "external_id,name,phone,wilaya,commune,address,product,variant,qty,price,shipping_fee,delivery_type,note\nA-1001,Amine Benali,0550123456,Alger,Kouba,Cité 5,Abaya,M,1,6500,500,HOME,\n";

export function ImportForm({ stores }: { stores: Array<{ id: string; name: string }> }) {
  const t = useTranslations("importOrders");
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label={t("store")}>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} className="text-sm" />
        <Textarea rows={10} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={TEMPLATE} className="font-mono text-xs" dir="ltr" />
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        <div className="flex gap-2">
          <Button disabled={pending || !csv.trim()} onClick={() => start(async () => setResult(await importOrdersAction({ storeId, csv })))}>{t("run")}</Button>
          <Button variant="outline" asChild><a href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="orders-template.csv">{t("template")}</a></Button>
        </div>
        {result ? (
          <Alert variant={result.ok ? "default" : "destructive"}>
            <AlertDescription>
              {result.message ?? t("result", { created: result.created, existing: result.existing, errors: result.errors.length })}
              {result.errors.length > 0 ? <ul className="mt-2 list-disc ps-5 text-xs">{result.errors.slice(0, 20).map((e) => <li key={e.row}>#{e.row}: {e.message}</li>)}</ul> : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
