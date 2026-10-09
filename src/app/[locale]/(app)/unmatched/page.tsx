import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { UnmatchedLines } from "@/components/orders/unmatched-lines";

/** Orders whose SKU is not in the catalog (section 19c.4): map the SKU once, it is auto-applied afterwards. */
export default async function UnmatchedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("unmatched");
  const orders = await prisma.order.findMany({
    where: { merchantId: { in: ctx.accessibleMerchantIds }, unmatchedLines: { some: { resolvedProductId: null } } },
    include: { unmatchedLines: { where: { resolvedProductId: null } }, store: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const products = await prisma.product.findMany({ where: { merchantId: { in: ctx.accessibleMerchantIds } }, select: { id: true, name: true, merchantId: true, variants: { select: { id: true, name: true } } }, orderBy: { name: "asc" } });
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("subtitle", { count: orders.length })} />
      {orders.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
      {orders.map((o) => (
        <Card key={o.id}>
          <CardContent className="space-y-2 pt-4 text-sm">
            <div className="flex gap-2"><Link href={`/orders/${o.id}`} className="font-mono underline">#{o.seq}</Link><span className="text-muted-foreground">{o.store.name}</span></div>
            <UnmatchedLines lines={o.unmatchedLines} products={products.filter((p) => p.merchantId === o.merchantId)} orderId={o.id} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
