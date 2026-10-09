import { getTranslations } from "next-intl/server";
import { requireContext } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DevicePairing } from "@/components/devices/device-pairing";

export default async function DevicesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requireContext(locale);
  const t = await getTranslations("devices");
  const supervisor = ["ORG_OWNER", "SUPERVISOR"].includes(ctx.role);
  const devices = await prisma.deviceToken.findMany({ where: { orgId: ctx.orgId, revokedAt: null, ...(supervisor ? {} : { userId: ctx.userId }) }, orderBy: { createdAt: "desc" } });
  const users = await prisma.user.findMany({ where: { id: { in: devices.map((d) => d.userId) } }, select: { id: true, name: true } });
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <DevicePairing devices={devices.map((d) => ({ id: d.id, name: d.name, user: users.find((u) => u.id === d.userId)?.name ?? "", lastSeen: formatDateTime(d.lastSeenAt, locale, ctx.timezone) }))} />
      <Card>
        <CardContent className="space-y-2 pt-6 text-sm text-muted-foreground">
          <p>{t("how1")}</p>
          <p>{t("how2")}</p>
          <p>{t("how3")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
