import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { ALL_STATUSES, STATUS_META } from "@/lib/orders/statuses";
import { PageHeader } from "@/components/page-header";
import { StatusLabelsForm } from "./status-labels-form";

export default async function StatusLabelsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ merchant?: string }> }) {
  const { locale } = await params;
  const { merchant } = await searchParams;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("settings.statuses");
  const merchants = await prisma.organization.findMany({ where: { id: { in: ctx.accessibleMerchantIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const merchantId = merchants.find((m) => m.id === merchant)?.id ?? merchants[0]?.id;
  const overrides = merchantId ? await prisma.statusLabelOverride.findMany({ where: { merchantId } }) : [];
  const byCode = new Map(overrides.map((o) => [o.code, o]));
  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      {merchantId ? (
        <StatusLabelsForm
          merchants={merchants}
          merchantId={merchantId}
          rows={ALL_STATUSES.map((code) => ({ code, defaultFr: STATUS_META[code].fr, defaultAr: STATUS_META[code].ar, labelFr: byCode.get(code)?.labelFr ?? "", labelAr: byCode.get(code)?.labelAr ?? "" }))}
        />
      ) : null}
    </div>
  );
}
