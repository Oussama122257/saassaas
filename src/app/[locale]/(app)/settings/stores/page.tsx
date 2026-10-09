import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { addDays } from "@/lib/time";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateStoreForm } from "@/components/settings/create-store-form";

export default async function StoresPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("stores");
  const since = addDays(new Date(), -30);
  const [stores, merchants, counts, errors] = await Promise.all([
    prisma.store.findMany({ where: { merchantId: { in: ctx.accessibleMerchantIds } }, include: { merchant: { select: { name: true } } }, orderBy: [{ merchantId: "asc" }, { name: "asc" }] }),
    prisma.organization.findMany({ where: { id: { in: ctx.accessibleMerchantIds } }, select: { id: true, name: true } }),
    prisma.order.groupBy({ by: ["storeId"], where: { merchantId: { in: ctx.accessibleMerchantIds }, createdAt: { gte: since } }, _count: { _all: true }, _sum: { total: true } }),
    prisma.order.groupBy({ by: ["storeId"], where: { merchantId: { in: ctx.accessibleMerchantIds }, createdAt: { gte: since }, mappingErrors: { isEmpty: false } }, _count: { _all: true } }),
  ]);
  const countOf = new Map(counts.map((c) => [c.storeId, c]));
  const errOf = new Map(errors.map((c) => [c.storeId, c._count._all]));
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{t("name")}</TableHead>
                <TableHead className="text-start">{t("channel")}</TableHead>
                <TableHead className="text-start">{t("connection")}</TableHead>
                <TableHead className="text-end">{t("orders30d")}</TableHead>
                <TableHead className="text-end">{t("mappingErrors")}</TableHead>
                <TableHead className="text-start">{t("lastSync")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((s) => (
                <TableRow key={s.id}>
                  <TableCell><Link href={`/settings/stores/${s.id}`} className="font-medium underline-offset-2 hover:underline">{s.name}</Link><div className="text-xs text-muted-foreground">{s.merchant.name}</div></TableCell>
                  <TableCell><Badge variant="outline">{s.channel}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={s.connection === "CONNECTED" ? "secondary" : "destructive"}>{t(`state.${s.connection}` as "state.CONNECTED")}</Badge>
                    {s.lastError ? <div className="max-w-56 truncate text-xs text-destructive" title={s.lastError}>{s.lastError}</div> : null}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{countOf.get(s.id)?._count._all ?? 0}</TableCell>
                  <TableCell className="text-end tabular-nums">{(errOf.get(s.id) ?? 0) > 0 ? <span className="font-semibold text-amber-700">{errOf.get(s.id)}</span> : 0}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.lastSyncAt, locale, ctx.timezone)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <CreateStoreForm merchants={merchants} />
    </div>
  );
}
