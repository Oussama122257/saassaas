"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { resolveUnmatchedAction } from "@/app/[locale]/(app)/queue/actions";

interface Line {
  id: string;
  externalSku: string;
  productName: string;
  variantName: string | null;
  qty: number;
}

/** Map an unknown SKU to a catalog product once; the mapping is remembered for later orders (section 19c.4). */
export function UnmatchedLines({ lines, products, orderId }: { lines: Line[]; products: Array<{ id: string; name: string; variants: Array<{ id: string; name: string }> }>; orderId: string }) {
  const t = useTranslations("call");
  const router = useRouter();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (lines.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-amber-400 bg-amber-50 p-2 text-sm dark:bg-amber-950/30" data-testid="unmatched-lines">
      <p className="font-medium">{t("unmatched")}</p>
      {lines.map((l) => (
        <div key={l.id} className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{l.externalSku}</span>
          <span>{l.productName}{l.variantName ? ` · ${l.variantName}` : ""} × {l.qty}</span>
          <select className="h-8 rounded-md border bg-background px-2 text-xs" value={choice[l.id] ?? ""} onChange={(e) => setChoice((c) => ({ ...c, [l.id]: e.target.value }))}>
            <option value="">—</option>
            {products.flatMap((p) => [
              <option key={p.id} value={`${p.id}|`}>{p.name}</option>,
              ...p.variants.map((v) => <option key={v.id} value={`${p.id}|${v.id}`}>{p.name} · {v.name}</option>),
            ])}
          </select>
          <Button size="sm" disabled={pending || !choice[l.id]} onClick={() => {
            const [productId, variantId] = (choice[l.id] ?? "|").split("|");
            start(async () => {
              const r = await resolveUnmatchedAction({ lineId: l.id, productId: productId!, variantId: variantId || null, orderId });
              if (!r.ok) setError(r.message);
              else router.refresh();
            });
          }}>OK</Button>
        </div>
      ))}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
