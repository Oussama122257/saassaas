import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requirePageRole } from "@/lib/auth/guards";
import { listAuditLogs, listOrderEvents, orgMembers } from "@/lib/orders/repository";
import { SUPERVISOR_PLUS } from "@/lib/tenant";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AuditFilters } from "./audit-filters";

const EVENT_TYPES = ["STATUS_CHANGE", "ASSIGN", "REASSIGN", "NOTE", "FIELD_EDIT", "OVERRIDE", "COURIER_SYNC", "MESSAGE_SENT"];
const AUDIT_ACTIONS = ["LOGIN", "LOGOUT", "TOTP_ENABLED", "TOTP_DISABLED", "ORDER_OVERRIDE", "ORDERS_EXPORT", "ORDERS_BULK_REASSIGN", "API_KEY_CREATED", "API_KEY_REVOKED", "SETTINGS_UPDATED", "STATUS_LABELS_UPDATED", "IMPERSONATION_START", "IMPERSONATION_END"];

type SP = { tab?: string; actor?: string; type?: string; from?: string; to?: string; page?: string; pageSize?: string };

export default async function AuditPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<SP> }) {
  const { locale } = await params;
  const sp = await searchParams;
  const ctx = await requirePageRole(locale, SUPERVISOR_PLUS);
  const t = await getTranslations("audit");
  const tc = await getTranslations("common");
  const to = await getTranslations("order.events");
  const tab = sp.tab === "org" ? "org" : "events";
  const filters = {
    actorId: sp.actor || undefined,
    type: sp.type || undefined,
    from: sp.from && !Number.isNaN(Date.parse(sp.from)) ? new Date(sp.from) : undefined,
    to: sp.to && !Number.isNaN(Date.parse(sp.to)) ? new Date(`${sp.to}T23:59:59.999`) : undefined,
  };
  const page = Math.max(1, Number(sp.page) || 1);
  const pageSize = [20, 50, 100].includes(Number(sp.pageSize)) ? Number(sp.pageSize) : 50;
  const members = await orgMembers(ctx);
  const memberOptions = members.map((m) => ({ id: m.userId, name: m.user.name }));

  const result = tab === "events" ? await listOrderEvents(ctx, filters, { page, pageSize }) : await listAuditLogs(ctx, filters, { page, pageSize });

  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} />
      <div className="flex gap-2 border-b">
        {(["events", "org"] as const).map((k) => (
          <Link key={k} href={{ pathname: "/audit", query: { tab: k } }} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>
            {k === "events" ? t("orderEvents") : t("orgActions")}
          </Link>
        ))}
      </div>
      <AuditFilters members={memberOptions} types={tab === "events" ? EVENT_TYPES : AUDIT_ACTIONS} tab={tab} />
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-start">{t("when")}</TableHead>
              <TableHead className="text-start">{t("member")}</TableHead>
              <TableHead className="text-start">{t("actionType")}</TableHead>
              {tab === "events" ? <TableHead className="text-start">{t("order")}</TableHead> : null}
              <TableHead className="text-start">{t("details")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="h-20 text-center text-muted-foreground">{tc("noResults")}</TableCell></TableRow>
            ) : tab === "events" ? (
              (result.rows as Awaited<ReturnType<typeof listOrderEvents>>["rows"]).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(e.createdAt, locale, ctx.timezone)}</TableCell>
                  <TableCell>{e.actor?.name ?? tc("system")}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={e.type === "OVERRIDE" ? "font-medium text-rose-700" : ""}>{to(e.type as never)}</span>
                      {e.fromStatus ? <StatusBadge status={e.fromStatus} locale={locale} className="text-[11px]" /> : null}
                      {e.toStatus ? <>→ <StatusBadge status={e.toStatus} locale={locale} className="text-[11px]" /></> : null}
                    </div>
                  </TableCell>
                  <TableCell><Link href={`/orders/${e.order.id}`} className="font-mono underline-offset-2 hover:underline">#{e.order.seq}</Link></TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground">{JSON.stringify(e.payload)}</TableCell>
                </TableRow>
              ))
            ) : (
              (result.rows as Awaited<ReturnType<typeof listAuditLogs>>["rows"]).map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(a.createdAt, locale, ctx.timezone)}</TableCell>
                  <TableCell>{a.actor?.name ?? tc("system")}</TableCell>
                  <TableCell>{t.has(`actions.${a.action}` as never) ? t(`actions.${a.action}` as never) : a.action}{a.targetId ? <span className="text-xs text-muted-foreground"> · {a.targetType} {a.targetId}</span> : null}</TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground">{JSON.stringify(a.payload)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} />
    </div>
  );
}
