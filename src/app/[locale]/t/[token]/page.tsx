import type { OrderStatus } from "@prisma/client";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { prisma, withSystemContext } from "@/lib/db";
import { STATUS_META, statusLabel } from "@/lib/orders/statuses";
import { wilayaName } from "@/lib/wilayas";
import { formatDateTime, formatDzd } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Statuses a customer sees on the public tracking page (no internal call statuses). */
const PUBLIC_STEPS: OrderStatus[] = ["CONFIRMEE", "EN_PREPARATION", "PRET_A_EXPEDIER", "EXPEDIE", "ARRIVE_WILAYA", "STOP_DESK", "EN_LIVRAISON", "LIVRE", "RETOUR_EN_COURS"];

export const dynamic = "force-dynamic";

export default async function TrackingPage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token } = await params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) notFound();
  const t = await getTranslations("tracking");
  const order = await withSystemContext("public-tracking", () =>
    prisma.order.findFirst({
      where: { trackingToken: token, merchantId: { not: "" } },
      include: {
        store: { select: { name: true } },
        courier: { select: { name: true } },
        items: { include: { product: { select: { name: true } }, variant: { select: { name: true } } } },
        events: { where: { toStatus: { in: PUBLIC_STEPS } }, orderBy: { createdAt: "asc" }, select: { toStatus: true, createdAt: true } },
        merchant: { select: { timezone: true } },
      },
    }),
  );
  if (!order) notFound();
  const tz = order.merchant.timezone;
  const reached = new Map(order.events.map((e) => [e.toStatus!, e.createdAt]));
  const firstName = order.customerName?.split(" ")[0] ?? "";
  const cancelled = ["ANNULEE", "FAUSSE_COMMANDE", "DOUBLE", "INJOIGNABLE", "EXPIREE"].includes(order.status);
  const steps = PUBLIC_STEPS.filter((s) => reached.has(s) || ["CONFIRMEE", "EXPEDIE", "EN_LIVRAISON", "LIVRE"].includes(s));
  return (
    <main className="mx-auto max-w-lg space-y-4 p-4" data-testid="tracking-page">
      <div className="text-center">
        <div className="text-sm text-muted-foreground">{order.store.name}</div>
        <h1 className="text-xl font-semibold">{t("title", { seq: order.seq })}</h1>
        {firstName ? <p className="text-sm text-muted-foreground">{t("hello", { name: firstName })}</p> : null}
      </div>
      <Card>
        <CardContent className="space-y-2 pt-6 text-center">
          <div className="text-xs text-muted-foreground">{t("current")}</div>
          <div className="text-lg font-semibold" data-testid="tracking-status">{statusLabel(order.status, locale)}</div>
          {!cancelled && STATUS_META[order.status].group !== "RETURN" ? (
            <>
              <div className="text-xs text-muted-foreground">{t("amount")}</div>
              <div className="text-3xl font-bold tabular-nums">{formatDzd(order.total, locale)}</div>
            </>
          ) : null}
        </CardContent>
      </Card>
      {!cancelled ? (
        <Card>
          <CardContent className="pt-6">
            <ol className="space-y-3">
              {steps.map((s) => {
                const at = reached.get(s);
                return (
                  <li key={s} className="flex items-start gap-3">
                    <span className={cn("mt-1 size-3 shrink-0 rounded-full border-2", at ? "border-emerald-600 bg-emerald-600" : "border-muted-foreground/40")} aria-hidden />
                    <div>
                      <div className={cn("text-sm", at ? "font-medium" : "text-muted-foreground")}>{statusLabel(s, locale)}</div>
                      {at ? <div className="text-xs text-muted-foreground">{formatDateTime(at, locale, tz)}</div> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="space-y-1 pt-6 text-sm">
          <div>{order.items.map((i) => `${i.qty}× ${i.product.name}${i.variant ? ` (${i.variant.name})` : ""}`).join(", ")}</div>
          <div className="text-muted-foreground">{wilayaName(order.wilayaCode, locale)}{order.commune ? ` · ${order.commune}` : ""} · {order.deliveryType === "STOP_DESK" ? t("stopDesk") : t("home")}</div>
          {order.courier ? <div className="text-muted-foreground">{t("courier")}: {order.courier.name}{order.trackingNumber ? <span className="font-mono"> · {order.trackingNumber}</span> : null}</div> : null}
        </CardContent>
      </Card>
    </main>
  );
}
