import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { parseOrgSettings } from "@/lib/settings";
import { creditBalance } from "@/lib/messaging/credits";
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS } from "@/lib/messaging/templates";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MessagingSettingsForm } from "@/components/settings/messaging-settings-form";

export default async function MessagingSettingsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ merchant?: string }> }) {
  const { locale } = await params;
  const sp = await searchParams;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("messaging");
  const merchants = await prisma.organization.findMany({ where: { id: { in: ctx.accessibleMerchantIds } }, select: { id: true, name: true, settings: true } });
  const merchant = merchants.find((m) => m.id === sp.merchant) ?? merchants[0];
  if (!merchant) return <PageHeader title={t("title")} description={t("noMerchant")} />;
  const team = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { settings: true } });
  const [templates, balance, ledger, logs] = await Promise.all([
    prisma.messageTemplate.findMany({ where: { merchantId: merchant.id } }),
    creditBalance(merchant.id),
    prisma.messageCreditLedger.findMany({ where: { orgId: merchant.id }, orderBy: { createdAt: "desc" }, take: 15 }),
    prisma.messageLog.findMany({ where: { orgId: merchant.id }, orderBy: { sentAt: "desc" }, take: 30, include: { order: { select: { seq: true } } } }),
  ]);
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <MessagingSettingsForm
        merchants={merchants.map((m) => ({ id: m.id, name: m.name }))}
        merchantId={merchant.id}
        teamOrgId={ctx.orgId}
        messaging={parseOrgSettings(merchant.settings).messaging}
        telephony={parseOrgSettings(team?.settings).telephony}
        templates={templates.map((x) => ({ key: x.key, channel: x.channel, lang: x.lang, body: x.body, waTemplateName: x.waTemplateName, waLanguage: x.waLanguage, active: x.active }))}
        defaults={Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, { fr: DEFAULT_TEMPLATES[k].fr, ar: DEFAULT_TEMPLATES[k].ar }]))}
        balance={balance}
        isPlatformAdmin={ctx.isPlatformAdmin}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("ledger")}</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {ledger.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(l.createdAt, locale, ctx.timezone)}</TableCell>
                    <TableCell className="text-xs">{l.reason}</TableCell>
                    <TableCell className={l.delta < 0 ? "text-end text-rose-700" : "text-end text-emerald-700"}>{l.delta > 0 ? `+${l.delta}` : l.delta}</TableCell>
                    <TableCell className="text-end font-mono text-xs">{l.balanceAfter}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t("log")}</CardTitle></CardHeader>
          <CardContent>
            <Table data-testid="message-log">
              <TableHeader>
                <TableRow><TableHead className="text-start">#</TableHead><TableHead className="text-start">{t("template")}</TableHead><TableHead className="text-start">{t("channel")}</TableHead><TableHead className="text-start">{t("status")}</TableHead><TableHead className="text-start">{t("date")}</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs">{l.order ? `#${l.order.seq}` : "—"}</TableCell>
                    <TableCell className="text-xs">{l.template}</TableCell>
                    <TableCell className="text-xs">{l.channel}</TableCell>
                    <TableCell><Badge variant={l.status === "FAILED" ? "destructive" : "outline"} className="text-[10px]">{l.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(l.sentAt, locale, ctx.timezone)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
