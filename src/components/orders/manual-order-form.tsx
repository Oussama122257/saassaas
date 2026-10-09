"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatDzd } from "@/lib/utils";
import { createManualOrderAction } from "@/app/[locale]/(app)/orders/manual-actions";

type Product = { id: string; name: string; price: number; merchantId: string; variants: Array<{ id: string; name: string; price: number | null }> };
const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function ManualOrderForm({ stores, products, communes, wilayas, locale }: { stores: Array<{ id: string; name: string; merchantId: string }>; products: Product[]; communes: Array<{ wilayaCode: number; nameFr: string; nameAr: string }>; wilayas: Array<{ code: number; name: string }>; locale: string }) {
  const t = useTranslations("manualOrder");
  const router = useRouter();
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const merchantId = stores.find((s) => s.id === storeId)?.merchantId;
  const catalog = useMemo(() => products.filter((p) => p.merchantId === merchantId), [products, merchantId]);
  const [lines, setLines] = useState([{ productId: catalog[0]?.id ?? "", variantId: "", qty: 1 }]);
  const [wilaya, setWilaya] = useState(16);
  const [deliveryType, setDeliveryType] = useState<"HOME" | "STOP_DESK">("HOME");
  const [shippingFee, setShippingFee] = useState(500);
  const [freeDelivery, setFreeDelivery] = useState(false);
  const [abandoned, setAbandoned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ar = locale.startsWith("ar");

  const priceOf = (l: { productId: string; variantId: string }) => {
    const p = catalog.find((x) => x.id === l.productId);
    return p?.variants.find((v) => v.id === l.variantId)?.price ?? p?.price ?? 0;
  };
  const subtotal = lines.reduce((a, l) => a + priceOf(l) * l.qty, 0);
  const total = subtotal + (freeDelivery ? 0 : shippingFee);

  const submit = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const s = (k: string) => (fd.get(k) ? String(fd.get(k)) : undefined);
    start(async () => {
      const r = await createManualOrderAction({
        storeId,
        externalId: s("externalId"),
        name: s("name"),
        phone: s("phone") ?? "",
        phone2: s("phone2"),
        wilaya,
        commune: s("commune"),
        address: s("address"),
        address2: s("address2"),
        landmark: s("landmark"),
        note: s("note"),
        abandonedCartRecovery: abandoned,
        deliveryType,
        shippingFee,
        freeDelivery,
        items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, variantId: l.variantId || undefined, qty: l.qty })),
      });
      if (r.ok) router.push(`/orders/${r.orderId}`);
      else setError(r.message);
    });
  };

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget); }} data-testid="manual-order-form">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
          <div className="space-y-1"><Label>{t("store")}</Label>
            <select className={selectCls} value={storeId} onChange={(e) => { setStoreId(e.target.value); setLines([{ productId: "", variantId: "", qty: 1 }]); }}>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>{t("externalId")}</Label><Input name="externalId" /></div>
          <div className="space-y-1"><Label>{t("name")}</Label><Input name="name" /></div>
          <div className="space-y-1"><Label>{t("phone")} *</Label><Input name="phone" required dir="ltr" inputMode="tel" /></div>
          <div className="space-y-1"><Label>{t("phone2")}</Label><Input name="phone2" dir="ltr" inputMode="tel" /></div>
          <div className="space-y-1"><Label>{t("wilaya")} *</Label>
            <select className={selectCls} value={wilaya} onChange={(e) => setWilaya(Number(e.target.value))}>
              {wilayas.map((w) => <option key={w.code} value={w.code}>{String(w.code).padStart(2, "0")} – {w.name}</option>)}
            </select>
          </div>
          <div className="space-y-1"><Label>{t("commune")}</Label>
            <Input name="commune" list="communes" />
            <datalist id="communes">{communes.filter((c) => c.wilayaCode === wilaya).map((c) => <option key={c.nameFr} value={ar ? c.nameAr : c.nameFr} />)}</datalist>
          </div>
          <div className="space-y-1"><Label>{t("address")}</Label><Input name="address" /></div>
          <div className="space-y-1"><Label>{t("address2")}</Label><Input name="address2" /></div>
          <div className="space-y-1"><Label>{t("landmark")}</Label><Input name="landmark" /></div>
          <div className="space-y-1 sm:col-span-2"><Label>{t("note")}</Label><Textarea name="note" rows={2} /></div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={abandoned} onCheckedChange={(v) => setAbandoned(!!v)} /> {t("abandoned")}</label>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 pt-6">
          {lines.map((l, i) => {
            const p = catalog.find((x) => x.id === l.productId);
            return (
              <div key={i} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-6 space-y-1"><Label>{t("product")}</Label>
                  <select className={selectCls} value={l.productId} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: e.target.value, variantId: "" } : x)))} required>
                    <option value="">—</option>
                    {catalog.map((c) => <option key={c.id} value={c.id}>{c.name} — {formatDzd(c.price, locale)}</option>)}
                  </select>
                </div>
                <div className="col-span-3 space-y-1"><Label>{t("variant")}</Label>
                  <select className={selectCls} value={l.variantId} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, variantId: e.target.value } : x)))} disabled={!p?.variants.length}>
                    <option value="">—</option>
                    {p?.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="col-span-2 space-y-1"><Label>{t("qty")}</Label><Input type="number" min={1} max={100} value={l.qty} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} /></div>
                <Button type="button" variant="ghost" size="icon" className="col-span-1" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1} aria-label="remove"><Trash2 className="size-4" /></Button>
              </div>
            );
          })}
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { productId: "", variantId: "", qty: 1 }])}><Plus className="size-4" /> {t("addLine")}</Button>
          <div className="grid gap-3 border-t pt-3 sm:grid-cols-3">
            <div className="space-y-1"><Label>{t("deliveryType")}</Label>
              <select className={selectCls} value={deliveryType} onChange={(e) => setDeliveryType(e.target.value as "HOME")}>
                <option value="HOME">{t("home")}</option>
                <option value="STOP_DESK">Stop Desk</option>
              </select>
            </div>
            <div className="space-y-1"><Label>{t("shippingFee")}</Label><Input type="number" min={0} value={shippingFee} disabled={freeDelivery} onChange={(e) => setShippingFee(Number(e.target.value))} /></div>
            <label className="flex items-center gap-2 pt-6 text-sm"><Checkbox checked={freeDelivery} onCheckedChange={(v) => setFreeDelivery(!!v)} /> {t("freeDelivery")}</label>
          </div>
          <div className="flex items-baseline justify-between border-t pt-3">
            <span className="text-muted-foreground">{t("total")}</span>
            <span className="text-2xl font-bold tabular-nums">{formatDzd(total, locale)}</span>
          </div>
        </CardContent>
      </Card>
      <Button type="submit" size="lg" disabled={pending} data-testid="manual-order-submit">{t("create")}</Button>
    </form>
  );
}
