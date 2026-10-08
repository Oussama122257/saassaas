import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireContext } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { orderAccessWhere } from "@/lib/tenant";
import { STATUS_GROUPS, STATUS_META, groupLabel, statusLabel } from "@/lib/orders/statuses";
import { startOfDayInTz } from "@/lib/time";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default async function DashboardPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ forbidden?: string }> }) {
  const { locale } = await params;
  const { forbidden } = await searchParams;
  const ctx = await requireContext(locale);
  const t = await getTranslations("dashboard");
  const te = await getTranslations("errors");
  const tc = await getTranslations("common");
  const where = orderAccessWhere(ctx);
  const today = startOfDayInTz(new Date(), ctx.timezone);

  const [ordersToday, confirmedToday, deliveredToday, openTasks, byStatus, recent] = await Promise.all([
    prisma.order.count({ where: { AND: [where, { createdAt: { gte: today } }] } }),
    prisma.order.count({ where: { AND: [where, { confirmedAt: { gte: today } }] } }),
    prisma.order.count({ where: { AND: [where, { deliveredAt: { gte: today } }] } }),
    prisma.task.count({ where: { doneAt: null, order: where } }),
    prisma.order.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.orderEvent.findMany({
      where: { order: where },
      include: { actor: { select: { name: true } }, order: { select: { id: true, seq: true } } },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);
  const counts = new Map(byStatus.map((b) => [b.status, b._count._all]));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("welcome", { name: ctx.userName })} />
      {forbidden ? <Alert variant="destructive"><AlertDescription>{te("forbidden")}</AlertDescription></Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="kpi-tiles">
        <Stat label={t("ordersToday")} value={ordersToday} />
        <Stat label={t("confirmedToday")} value={confirmedToday} />
        <Stat label={t("deliveredToday")} value={deliveredToday} />
        <Stat label={t("openTasks")} value={openTasks} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">{t("byStatus")}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {STATUS_GROUPS.map((g) => {
              const rows = [...counts.entries()].filter(([s]) => STATUS_META[s].group === g && (counts.get(s) ?? 0) > 0);
              if (rows.length === 0) return null;
              return (
                <div key={g}>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{groupLabel(g, locale)}</div>
                  <div className="flex flex-wrap gap-2">
                    {rows.map(([s, n]) => (
                      <Link key={s} href={{ pathname: "/orders", query: { status: s } }} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-accent">
                        <StatusBadge status={s} locale={locale} className="text-[11px]" />
                        <span className="font-mono">{n}</span>
                        <span className="sr-only">{statusLabel(s, locale)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">{t("kpiNote")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("recentActivity")}</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {recent.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Link href={`/orders/${e.order.id}`} className="font-mono underline-offset-2 hover:underline">#{e.order.seq}</Link>
                  {e.toStatus ? <StatusBadge status={e.toStatus} locale={locale} className="text-[11px]" /> : <span className="text-xs">{e.type}</span>}
                  <span className="text-xs text-muted-foreground">{e.actor?.name ?? tc("system")} · {formatDateTime(e.createdAt, locale, ctx.timezone)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-3xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
