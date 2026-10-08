import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireContext } from "@/lib/auth/guards";
import { customerHistory, getOrderDetail, orderFilterOptions } from "@/lib/orders/repository";
import { allowedTargets } from "@/lib/orders/transitions";
import { ALL_STATUSES, CANCEL_REASON_LABELS, RETURN_REASON_LABELS, statusLabel } from "@/lib/orders/statuses";
import { actorRole, isReadOnly, isSupervisorPlus } from "@/lib/tenant";
import { wilayaName } from "@/lib/wilayas";
import { formatDateTime, formatDzd } from "@/lib/utils";
import { formatPhone } from "@/lib/phone";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChangeDialog } from "@/components/orders/status-change-dialog";
import { AssignDialog } from "@/components/orders/assign-dialog";
import { NoteForm } from "@/components/orders/note-form";
import { OrderTimeline } from "@/components/orders/order-timeline";

export default async function OrderDetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const ctx = await requireContext(locale);
  const order = await getOrderDetail(ctx, id);
  if (!order) notFound();
  const t = await getTranslations("order");
  const tc = await getTranslations("common");
  const tz = order.merchant.timezone;

  const [history, options] = await Promise.all([customerHistory(ctx, order.merchantId, order.customerPhone, order.id), orderFilterOptions(ctx)]);
  const agents = options.agents.filter((a) => a.role !== "SUPERVISOR");
  const readOnly = isReadOnly(ctx);
  const targets = readOnly
    ? []
    : allowedTargets(order.status, actorRole(ctx)).map(({ to, rule }) => ({ to, ruleId: rule.id, label: statusLabel(to, locale) }));
  const canOverride = !readOnly && isSupervisorPlus(ctx);
  const overrideOptions = ALL_STATUSES.filter((s) => s !== "INJOIGNABLE" && s !== order.status).map((code) => ({ code, label: statusLabel(code, locale) }));
  const ar = locale.startsWith("ar");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title", { seq: order.seq })}
        description={`${order.store.name} · ${formatDateTime(order.createdAt, locale, tz)}${order.externalId ? ` · ${t("externalId")}: ${order.externalId}` : ""}`}
        actions={
          <>
            <StatusBadge status={order.status} locale={locale} className="text-sm" />
            {!readOnly && isSupervisorPlus(ctx) ? <AssignDialog locale={locale} orderId={order.id} agents={agents} currentId={order.assignedToId} /> : null}
            {!readOnly ? <StatusChangeDialog locale={locale} orderId={order.id} targets={targets} canOverride={canOverride} overrideOptions={overrideOptions} agents={agents} /> : null}
          </>
        }
      />

      {order.flags.length > 0 ? (
        <div className="flex flex-wrap gap-1" data-testid="order-flags">
          {order.flags.map((f) => (
            <Badge key={f} variant="secondary" className="font-mono text-[11px]">{f}</Badge>
          ))}
          {order.duplicateOf ? (
            <Link href={`/orders/${order.duplicateOf.id}`} className="text-xs underline">{t("duplicateOf", { seq: order.duplicateOf.seq })}</Link>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("customer")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <div className="text-lg font-semibold">{order.customerName ?? "—"}</div>
              <a href={`tel:${order.customerPhone}`} className="font-mono text-base underline-offset-2 hover:underline" dir="ltr">{formatPhone(order.customerPhone)}</a>
              {order.customerPhone2 ? <div className="font-mono text-muted-foreground" dir="ltr">{formatPhone(order.customerPhone2)}</div> : null}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{t("ordersCount", { count: order.customer.ordersCount })}</Badge>
              <Badge variant="outline" className="text-emerald-700">{t("delivered", { count: order.customer.deliveredCount })}</Badge>
              <Badge variant="outline" className="text-rose-700">{t("refused", { count: order.customer.refusedCount })}</Badge>
              {order.customer.blacklisted ? <Badge variant="destructive">{t("blacklisted")}</Badge> : null}
            </div>
            <div>
              <div className="mb-1 font-medium">{t("history")}</div>
              {history.length === 0 ? (
                <p className="text-muted-foreground">{t("historyEmpty")}</p>
              ) : (
                <ul className="space-y-1">
                  {history.map((h) => (
                    <li key={h.id} className="flex items-center justify-between gap-2">
                      <Link href={`/orders/${h.id}`} className="font-mono underline-offset-2 hover:underline">#{h.seq}</Link>
                      <StatusBadge status={h.status} locale={locale} className="text-[11px]" />
                      <span className="text-muted-foreground">{formatDzd(h.total, locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">{t("items")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">{t("items")}</TableHead>
                  <TableHead className="text-end">{t("qty")}</TableHead>
                  <TableHead className="text-end">{t("unitPrice")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.product.name}{i.variant ? <span className="text-muted-foreground"> · {i.variant.name}</span> : null}</TableCell>
                    <TableCell className="text-end">{i.qty}</TableCell>
                    <TableCell className="text-end">{formatDzd(i.unitPrice, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <dl className="space-y-1">
              <div className="flex justify-between"><dt className="text-muted-foreground">{t("subtotal")}</dt><dd>{formatDzd(order.subtotal, locale)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{t("shippingFee")}</dt><dd>{formatDzd(order.shippingFee, locale)}</dd></div>
              <div className="flex items-baseline justify-between border-t pt-2"><dt className="font-medium">{t("totalToPay")}</dt><dd className="text-2xl font-bold" data-testid="order-total">{formatDzd(order.total, locale)}</dd></div>
            </dl>
            {order.cancelReason ? <p><span className="text-muted-foreground">{t("cancelReason")}:</span> {ar ? CANCEL_REASON_LABELS[order.cancelReason].ar : CANCEL_REASON_LABELS[order.cancelReason].fr}</p> : null}
            {order.returnReason ? <p><span className="text-muted-foreground">{t("returnReason")}:</span> {ar ? RETURN_REASON_LABELS[order.returnReason].ar : RETURN_REASON_LABELS[order.returnReason].fr}</p> : null}
            {order.reasonNote ? <p className="text-muted-foreground">{t("reasonNote")}: {order.reasonNote}</p> : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">{t("delivery")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium">{String(order.wilayaCode).padStart(2, "0")} – {wilayaName(order.wilayaCode, locale)}{order.commune ? ` · ${order.commune}` : ""}</p>
              <p>{t(`deliveryType.${order.deliveryType}`)}</p>
              {order.address ? <p className="text-muted-foreground">{order.address}</p> : null}
              {order.landmark ? <p className="text-muted-foreground">{t("landmark")}: {order.landmark}</p> : null}
              {order.courier ? <p>{order.courier.name}{order.trackingNumber ? <span className="font-mono"> · {order.trackingNumber}</span> : null}</p> : null}
              {order.source ? <p className="text-xs text-muted-foreground">{t("source")}: {order.source}</p> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">{t("assignment")}</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p><span className="text-muted-foreground">{t("assignedTo")}:</span> {order.assignedTo?.name ?? t("unassigned")}</p>
              <p><span className="text-muted-foreground">{t("confirmedBy")}:</span> {order.confirmedBy?.name ?? "—"}</p>
              <p><span className="text-muted-foreground">{t("pod")}:</span> {order.pod?.name ?? "—"}</p>
              <p><span className="text-muted-foreground">{t("attempts")}:</span> <span className="font-mono">{order.attemptCount}/9</span>{order.nextActionAt ? <span className="text-muted-foreground"> · → {formatDateTime(order.nextActionAt, locale, tz)}</span> : null}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">{t("timeline")} ({order.events.length})</TabsTrigger>
          <TabsTrigger value="calls">{t("attempts")} ({order.calls.length})</TabsTrigger>
          <TabsTrigger value="courier">{t("courierEvents")} ({order.courierEvents.length})</TabsTrigger>
          <TabsTrigger value="tasks">{t("tasks")} ({order.tasks.length})</TabsTrigger>
          <TabsTrigger value="messages">{t("messages")} ({order.messages.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="space-y-4 pt-4">
          {!readOnly ? <NoteForm locale={locale} orderId={order.id} /> : null}
          <OrderTimeline events={order.events} locale={locale} timezone={tz} />
        </TabsContent>
        <TabsContent value="calls" className="pt-4">
          {order.calls.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noCalls")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-start">#</TableHead>
                  <TableHead className="text-start">{t("dayLabel")}</TableHead>
                  <TableHead className="text-start">{tc("date")}</TableHead>
                  <TableHead className="text-start">{t("assignedTo")}</TableHead>
                  <TableHead className="text-start">{t("outcomeLabel")}</TableHead>
                  <TableHead className="text-start">{t("proofLabel")}</TableHead>
                  <TableHead className="text-end">{t("durationLabel")}</TableHead>
                  <TableHead className="text-end">QA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.calls.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono">{c.attemptNo}</TableCell>
                    <TableCell>{t("day", { n: c.day })} · {t(`slot.${c.slot}`)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(c.startedAt, locale, tz)}</TableCell>
                    <TableCell>{c.agent.name}{c.phoneNumber ? <span className="text-muted-foreground"> · {c.phoneNumber.label}</span> : null}</TableCell>
                    <TableCell>{t(`outcome.${c.outcome}`)}</TableCell>
                    <TableCell>{t(`proof.${c.proof}`)}</TableCell>
                    <TableCell className="text-end font-mono">{c.durationSec ?? "—"}</TableCell>
                    <TableCell className="text-end font-mono">{c.qaScore ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="courier" className="pt-4">
          <ul className="space-y-1 text-sm">
            {order.courierEvents.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{formatDateTime(e.receivedAt, locale, tz)}</span>
                <span className="font-mono text-xs">{e.provider}</span>
                <span>{e.rawStatus}</span>
                {e.mappedStatus ? <StatusBadge status={e.mappedStatus} locale={locale} className="text-[11px]" /> : <Badge variant="outline">unmapped</Badge>}
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="tasks" className="pt-4">
          <ul className="space-y-1 text-sm">
            {order.tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={task.doneAt ? "secondary" : "default"}>{task.doneAt ? t("taskDone") : t("taskOpen")}</Badge>
                <span>{t(`taskTypes.${task.type}`)}</span>
                <span className="text-xs text-muted-foreground">{t("taskDue")}: {formatDateTime(task.dueAt, locale, tz)}</span>
                {task.assignee ? <span className="text-xs text-muted-foreground">· {task.assignee.name}</span> : null}
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="messages" className="pt-4">
          <ul className="space-y-1 text-sm">
            {order.messages.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{formatDateTime(m.sentAt, locale, tz)}</span>
                <Badge variant="outline">{m.channel}</Badge>
                <span className="font-mono text-xs">{m.template}</span>
                <span className="text-muted-foreground">{m.status}</span>
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}
