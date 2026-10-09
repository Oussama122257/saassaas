import { getTranslations } from "next-intl/server";
import { requireContext } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import { ManualOrderForm } from "@/components/orders/manual-order-form";
import { WILAYAS } from "@/lib/wilayas";

export default async function NewOrderPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requireContext(locale);
  const t = await getTranslations("manualOrder");
  const [stores, products, communes] = await Promise.all([
    prisma.store.findMany({ where: { merchantId: { in: ctx.accessibleMerchantIds }, active: true }, select: { id: true, name: true, merchantId: true }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { merchantId: { in: ctx.accessibleMerchantIds }, active: true }, select: { id: true, name: true, price: true, merchantId: true, variants: { select: { id: true, name: true, price: true } } }, orderBy: { name: "asc" } }),
    prisma.commune.findMany({ select: { wilayaCode: true, nameFr: true, nameAr: true }, orderBy: { nameFr: "asc" } }),
  ]);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <ManualOrderForm stores={stores} products={products} communes={communes} wilayas={WILAYAS.map((w) => ({ code: w.code, name: locale.startsWith("ar") ? w.nameAr : w.nameFr }))} locale={locale} />
    </div>
  );
}
