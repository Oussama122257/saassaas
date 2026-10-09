import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { startOfDayInTz } from "@/lib/time";
import { formatDateTime } from "@/lib/utils";
import { CONFIRMATION_OPEN_STATUSES } from "@/lib/orders/statuses";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShiftEditor } from "@/components/team/shift-editor";

export default async function TeamPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("team");
  const ta = await getTranslations("availability");
  const tr = await getTranslations("roles");
  const today = startOfDayInTz(new Date(), ctx.timezone);
  const members = await prisma.membership.findMany({
    where: { orgId: ctx.orgId, active: true, role: { in: ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR", "WAREHOUSE"] } },
    include: { user: { select: { id: true, name: true, email: true } }, pod: { select: { name: true } } },
    orderBy: [{ podId: "asc" }, { role: "asc" }],
  });
  const ids = members.map((m) => m.userId);
  const [shifts, attempts, confirmations, assigned, lastEvents] = await Promise.all([
    prisma.shift.findMany({ where: { orgId: ctx.orgId, userId: { in: ids } } }),
    prisma.callAttempt.groupBy({ by: ["agentId"], where: { agentId: { in: ids }, startedAt: { gte: today }, order: { merchantId: { in: ctx.accessibleMerchantIds } } }, _count: { _all: true } }),
    prisma.order.groupBy({ by: ["confirmedById"], where: { confirmedById: { in: ids }, confirmedAt: { gte: today }, merchantId: { in: ctx.accessibleMerchantIds } }, _count: { _all: true } }),
    prisma.order.groupBy({ by: ["assignedToId"], where: { assignedToId: { in: ids }, status: { in: CONFIRMATION_OPEN_STATUSES }, merchantId: { in: ctx.accessibleMerchantIds } }, _count: { _all: true } }),
    prisma.orderEvent.groupBy({ by: ["actorId"], where: { actorId: { in: ids }, createdAt: { gte: today }, order: { merchantId: { in: ctx.accessibleMerchantIds } } }, _count: { _all: true }, _max: { createdAt: true } }),
  ]);
  const by = <T extends { _count: { _all: number } }>(rows: T[], key: keyof T) => new Map(rows.map((r) => [r[key] as unknown as string, r]));
  const att = by(attempts, "agentId");
  const conf = by(confirmations, "confirmedById");
  const asg = by(assigned, "assignedToId");
  const ev = by(lastEvents, "actorId");
  const days = ["0", "1", "2", "3", "4", "5", "6"];
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table data-testid="team-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t("agent")}</TableHead>
                <TableHead className="text-start">{t("pod")}</TableHead>
                <TableHead className="text-start">{ta("label")}</TableHead>
                <TableHead className="text-end">{t("attempts")}</TableHead>
                <TableHead className="text-end">{t("confirmations")}</TableHead>
                <TableHead className="text-end">{t("actions")}</TableHead>
                <TableHead className="text-end">{t("assigned")}</TableHead>
                <TableHead className="text-start">{t("lastActivity")}</TableHead>
                <TableHead className="text-start">{t("shifts")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const mine = shifts.filter((s) => s.userId === m.userId);
                const lastAt = (ev.get(m.userId) as { _max?: { createdAt: Date | null } } | undefined)?._max?.createdAt ?? null;
                return (
                  <TableRow key={m.id}>
                    <TableCell><div className="font-medium">{m.user.name}</div><div className="text-xs text-muted-foreground">{tr(m.role)}</div></TableCell>
                    <TableCell>{m.pod?.name ?? "—"}</TableCell>
                    <TableCell><Badge variant={m.availability === "AVAILABLE" ? "secondary" : "outline"}>{ta(m.availability)}</Badge></TableCell>
                    <TableCell className="text-end tabular-nums">{att.get(m.userId)?._count._all ?? 0}</TableCell>
                    <TableCell className="text-end tabular-nums">{conf.get(m.userId)?._count._all ?? 0}</TableCell>
                    <TableCell className="text-end tabular-nums">{ev.get(m.userId)?._count._all ?? 0}</TableCell>
                    <TableCell className="text-end tabular-nums">{asg.get(m.userId)?._count._all ?? 0}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(lastAt, locale, ctx.timezone)}</TableCell>
                    <TableCell>
                      <ShiftEditor userId={m.userId} days={days.filter((d) => mine.some((s) => s.weekday === Number(d))).map(Number)} startMin={mine[0]?.startMin ?? 540} endMin={mine[0]?.endMin ?? 1020} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
