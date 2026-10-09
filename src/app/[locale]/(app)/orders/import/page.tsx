import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import { ImportForm } from "@/components/orders/import-form";

export default async function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("importOrders");
  const stores = await prisma.store.findMany({ where: { merchantId: { in: ctx.accessibleMerchantIds }, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <ImportForm stores={stores} />
    </div>
  );
}
