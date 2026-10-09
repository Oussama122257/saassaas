import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { queueStats } from "@/lib/calls/agentQueue";
import { startOfDayInTz } from "@/lib/time";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { NextOrderButton } from "@/components/queue/next-order-button";

export default async function QueuePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR", "ORG_OWNER"]);
  const t = await getTranslations("queue");
  const stats = await queueStats(ctx, startOfDayInTz(new Date(), ctx.timezone));
  const tiles: Array<[string, number]> = [
    [t("stats.due"), stats.due],
    [t("stats.newOrders"), stats.newOrders],
    [t("stats.callbacks"), stats.callbacks],
    [t("stats.upcoming"), stats.upcoming],
    [t("stats.doneToday"), stats.doneToday],
  ];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="queue-stats">
        {tiles.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="text-2xl font-semibold tabular-nums">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <NextOrderButton locale={locale} />
      <p className="text-xs text-muted-foreground">{t("shortcuts")}</p>
    </div>
  );
}
