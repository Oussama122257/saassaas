import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { parseOrgSettings } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { OpsSettingsForm } from "@/components/settings/ops-settings-form";

export default async function OperationsSettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("ops");
  const [org, merchants, numbers, agents] = await Promise.all([
    prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { id: true, name: true, settings: true } }),
    prisma.organization.findMany({ where: { id: { in: ctx.accessibleMerchantIds } }, select: { id: true, name: true, settings: true } }),
    prisma.outboundNumber.findMany({ where: { orgId: ctx.orgId }, orderBy: { label: "asc" } }),
    prisma.membership.findMany({ where: { orgId: ctx.orgId, role: "CONFIRMATION_AGENT", active: true }, select: { userId: true, user: { select: { name: true } } } }),
  ]);
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <OpsSettingsForm
        orgId={ctx.orgId}
        settings={parseOrgSettings(org?.settings)}
        merchants={merchants.map((m) => ({ id: m.id, name: m.name, settings: parseOrgSettings(m.settings) }))}
        numbers={numbers.map((n) => ({ id: n.id, label: n.label, msisdn: n.msisdn, active: n.active, answerRate: n.answerRate, burnedAt: n.burnedAt?.toISOString() ?? null }))}
        agents={agents.map((a) => ({ id: a.userId, name: a.user.name }))}
      />
    </div>
  );
}
