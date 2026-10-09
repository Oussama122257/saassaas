"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Copy, Lock, Phone, PhoneOff, SkipForward } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import type { CallScreenData } from "@/lib/calls/callScreen";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CANCEL_REASON_LABELS, FAKE_REASON_LABELS } from "@/lib/orders/statuses";
import { formatPhone } from "@/lib/phone";
import { wilayaName } from "@/lib/wilayas";
import { cn, formatDateTime, formatDzd } from "@/lib/utils";
import { CommentsPanel } from "@/components/orders/comments-panel";
import { UnmatchedLines } from "@/components/orders/unmatched-lines";
import { callProofStatusAction, decisionAction, logAttemptAction, nextOrderAction, proposeFakeQueueAction, skipAction, startCallAction, type QueueActionResult } from "@/app/[locale]/(app)/queue/actions";

const OUTCOMES = ["ANSWERED", "NO_ANSWER", "BUSY", "OFF", "WRONG_NUMBER", "CALLBACK_REQUESTED"] as const;
const CHECKS = ["productExplained", "totalStated", "addressVerified", "variantVerified", "explicitYes"] as const;
const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";

type Panel = null | "postpone" | "confirmPostponed" | "verify" | "cancel" | "fake";

export function CallScreen({ data, locale, userId }: { data: CallScreenData; locale: string; userId: string }) {
  const t = useTranslations("call");
  const tq = useTranslations("queue");
  const to = useTranslations("order.outcome");
  const ts = useTranslations("order.slot");
  const tf = useTranslations("transition.fields");
  const te = useTranslations("transition.errors");
  const router = useRouter();
  const { order } = data;
  const ar = locale.startsWith("ar");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [duration, setDuration] = useState(45);
  const [callbackAt, setCallbackAt] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [panel, setPanel] = useState<Panel>(null);
  const [upsellOn, setUpsellOn] = useState(false);
  const [upsell, setUpsell] = useState<{ kind: "UPSELL" | "CROSS_SELL"; productId: string; variantId: string; qty: number }>({ kind: "UPSELL", productId: order.items[0]?.productId ?? data.products[0]?.id ?? "", variantId: "", qty: 1 });
  const [seriousOpen, setSeriousOpen] = useState(false);
  const [callActive, setCallActive] = useState(false);
  const [proof, setProof] = useState<{ proof: string | null; durationSec: number | null; suggestedOutcome: string | null } | null>(null);

  // poll for the device log / CDR of the call in progress (section 8.3)
  useEffect(() => {
    if (!callActive || proof?.proof) return;
    const started = Date.now();
    const id = window.setInterval(async () => {
      const s = await callProofStatusAction({ orderId: order.id });
      if (s.proof) {
        setProof(s);
        if (s.durationSec !== null) setDuration(s.durationSec);
        window.clearInterval(id);
      }
      if (Date.now() - started > 10 * 60_000) window.clearInterval(id);
    }, 4000);
    return () => window.clearInterval(id);
  }, [callActive, proof?.proof, order.id]);

  const dial = () =>
    start(async () => {
      const r = await startCallAction({ orderId: order.id });
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setCallActive(true);
      setProof(null);
      if (r.dialUri) window.location.href = r.dialUri;
    });

  const answered = order.calls.some((c) => c.outcome === "ANSWERED" && c.round === order.recycleRound);
  const allChecked = CHECKS.every((k) => checks[k]);
  const lockedByOther = order.lockedById && order.lockedById !== userId;
  const reconfirm = order.status === "CONFIRMEE_REPORTEE";
  const roundCalls = order.calls.filter((c) => c.round === order.recycleRound);
  const decisionOpen = ["EN_COURS_CONFIRMATION", "ASSIGNEE", "APPEL_1", "APPEL_2", "APPEL_3", "REPORTE", "A_VERIFIER"].includes(order.status);

  const handle = (r: QueueActionResult, after?: "next" | "refresh") => {
    if (!r.ok) {
      const key = r.code as Parameters<typeof te>[0];
      setError(te.has(key) ? te(key, { detail: r.detail ?? r.message }) : r.message);
      return false;
    }
    setError(null);
    if (after === "next") void goNext();
    else router.refresh();
    return true;
  };

  const goNext = async () => {
    const r = await nextOrderAction();
    if (r.ok && r.next) router.push(`/queue/${r.next}`);
    else router.push("/queue");
  };

  const logOutcome = (outcome: (typeof OUTCOMES)[number]) => {
    if (outcome === "CALLBACK_REQUESTED" && !callbackAt) {
      setError(tf("callbackAt"));
      return;
    }
    start(async () => {
      const r = await logAttemptAction({ orderId: order.id, outcome, durationSec: outcome === "ANSWERED" ? duration : 0, callbackAt: outcome === "CALLBACK_REQUESTED" ? callbackAt : undefined, phoneNumberId: data.nextNumber?.id });
      if (handle(r, outcome === "ANSWERED" ? "refresh" : "next")) setNotice(t("done"));
    });
  };

  const decide = (toStatus: string, payload: Record<string, unknown>) => start(async () => { handle(await decisionAction({ orderId: order.id, to: toStatus, payload }), "next"); });

  const checklist = Object.fromEntries(CHECKS.map((k) => [k, !!checks[k]]));
  const upsellPayload = upsellOn && upsell.productId ? [{ kind: upsell.kind, customerAgreed: true, items: [{ productId: upsell.productId, variantId: upsell.variantId || null, qty: upsell.qty }] }] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 6 && decisionOpen && !lockedByOther) logOutcome(OUTCOMES[n - 1]!);
      if ((e.key === "c" || e.key === "C") && allChecked && answered && decisionOpen) decide("CONFIRMEE", { checklist, upsells: upsellPayload });
      if (e.key === "s" || e.key === "S") start(async () => { handle(await skipAction({ orderId: order.id }), "next"); });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const productVariants = useMemo(() => data.products.find((p) => p.id === upsell.productId)?.variants ?? [], [data.products, upsell.productId]);

  return (
    <div className="space-y-4" data-testid="call-screen">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/queue" className="text-sm text-muted-foreground hover:underline">← {t("backToQueue")}</Link>
        <h1 className="text-xl font-semibold">#{order.seq}</h1>
        <StatusBadge status={order.status} locale={locale} />
        <Badge variant="outline" className="font-mono">{t("attempt", { n: order.attemptCount, max: data.settings.maxAttempts })}</Badge>
        {order.recycleRound > 0 ? <Badge variant="secondary">RECYCLED</Badge> : null}
        <span className="text-sm text-muted-foreground">{order.store.name}</span>
        {order.lockedById === userId ? (
          <span className="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" aria-hidden /> {t("locked", { min: data.settings.lockTimeoutMin })}</span>
        ) : lockedByOther ? (
          <Badge variant="destructive" className="ms-auto">{t("lockedByOther", { name: order.lockedBy?.name ?? "" })}</Badge>
        ) : null}
      </div>
      {data.blocked ? <Alert><AlertDescription>{tq("blocked", { reason: tq(`blockReason.${data.blocked}`) })}</AlertDescription></Alert> : null}
      {error ? <Alert variant="destructive"><AlertDescription data-testid="call-error">{error}</AlertDescription></Alert> : null}
      {notice && !error ? <p className="text-sm text-emerald-700">{notice}</p> : null}
      {order.mappingErrors.length > 0 ? (
        <Alert><AlertDescription>{t("mappingErrors")}: <span className="font-mono">{order.mappingErrors.join(", ")}</span>{order.reasonNote ? ` — ${order.reasonNote}` : ""}</AlertDescription></Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        {/* customer + order */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("customer")}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="text-lg font-semibold">{order.customerName ?? "—"}</div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={dial} disabled={pending || !!data.blocked || !!lockedByOther} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 font-mono text-lg text-primary-foreground disabled:opacity-60" dir="ltr" data-testid="click-to-call">
                  <Phone className="size-4" aria-hidden /> {formatPhone(order.customerPhone)}
                </button>
                <a href={`tel:${order.customerPhone}`} className="text-xs text-muted-foreground underline" dir="ltr">tel:</a>
                <Button variant="ghost" size="icon" type="button" onClick={() => navigator.clipboard?.writeText(order.customerPhone)} aria-label="copy"><Copy className="size-4" /></Button>
              </div>
              {order.customerPhone2 ? <a href={`tel:${order.customerPhone2}`} className="block font-mono text-muted-foreground" dir="ltr">{formatPhone(order.customerPhone2)}</a> : null}
              {data.nextNumber ? <p className="text-xs text-muted-foreground">{t("fromNumber", { label: `${data.nextNumber.label} · ${data.nextNumber.msisdn}` })}</p> : null}
              <div className="flex flex-wrap gap-1.5" data-testid="repeat-badge">
                {data.history.length === 0 ? <Badge variant="outline">{t("firstOrder")}</Badge> : <Badge variant="secondary">{t("repeat", { count: data.history.length })}</Badge>}
                {order.customer.blacklisted ? <Badge variant="destructive">BLACKLIST</Badge> : null}
                {data.history.map((h) => <StatusBadge key={h.id} status={h.status} locale={locale} className="text-[10px]" />)}
              </div>
              <div className="border-t pt-2">
                <p className="font-medium">{String(order.wilayaCode).padStart(2, "0")} – {wilayaName(order.wilayaCode, locale)}{order.commune ? ` · ${order.commune}` : ""}</p>
                {order.address ? <p className="text-muted-foreground">{order.address}{order.address2 ? `, ${order.address2}` : ""}</p> : null}
                {order.landmark ? <p className="text-muted-foreground">📍 {order.landmark}</p> : null}
                <Badge variant="outline" className="mt-1">{order.deliveryType === "STOP_DESK" ? "Stop Desk" : "🏠"}</Badge>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{t("order")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <ul className="space-y-1">
                {order.items.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span>{i.product.name}{i.variant ? <span className="text-muted-foreground"> · {i.variant.name}</span> : null} × {i.qty}</span>
                    <span className="tabular-nums">{formatDzd(i.unitPrice * i.qty, locale)}</span>
                  </li>
                ))}
              </ul>
              <UnmatchedLines lines={order.unmatchedLines} products={data.products} orderId={order.id} />
              <div className="rounded-md bg-muted p-3 text-center">
                <div className="text-xs text-muted-foreground">{t("totalToPay")}</div>
                <div className="text-4xl font-bold tabular-nums" data-testid="total-to-pay">{formatDzd(order.total, locale)}</div>
                <div className="text-xs text-muted-foreground">{t("shipping", { fee: formatDzd(order.shippingFee, locale) })}</div>
              </div>
              <p className="text-xs text-muted-foreground">{t("stock", { n: data.stockAvailable })}</p>
            </CardContent>
          </Card>
        </div>

        {/* product sheet / script */}
        <Card className="xl:row-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-base">{t("script")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {data.sheets.length === 0 ? <p className="text-muted-foreground">{t("noSheet")}</p> : null}
            {data.sheets.map((s) => (
              <div key={s.productId} className="space-y-2">
                <div className="flex items-center gap-2 font-medium">{s.productName}{!s.approved ? <Badge variant="outline" className="text-[10px]">{t("sheetNotApproved")}</Badge> : null}</div>
                <Tabs defaultValue="script">
                  <TabsList>
                    <TabsTrigger value="script">{t("script")}</TabsTrigger>
                    <TabsTrigger value="points">{t("sellingPoints")}</TabsTrigger>
                    {s.sizeGuide ? <TabsTrigger value="size">{t("sizeGuide")}</TabsTrigger> : null}
                    <TabsTrigger value="faq">{t("faq")}</TabsTrigger>
                  </TabsList>
                  <TabsContent value="script" className="space-y-2 pt-2">
                    <p dir="rtl" className="whitespace-pre-line rounded-md bg-amber-50 p-3 text-base leading-relaxed dark:bg-amber-950/40" data-testid="script-ar">{s.scriptAr}</p>
                    {s.scriptFr ? <p dir="ltr" className="whitespace-pre-line rounded-md bg-muted p-3">{s.scriptFr}</p> : null}
                  </TabsContent>
                  <TabsContent value="points" className="pt-2">
                    <ul className="list-disc space-y-1 ps-5">{s.sellingPoints.map((p) => <li key={p}>{p}</li>)}</ul>
                  </TabsContent>
                  {s.sizeGuide ? <TabsContent value="size" className="whitespace-pre-line pt-2">{s.sizeGuide}</TabsContent> : null}
                  <TabsContent value="faq" className="space-y-2 pt-2">
                    {s.faq.map((f, i) => (
                      <div key={i}><p className="font-medium">{f.q}</p><p className="text-muted-foreground">{f.a}</p></div>
                    ))}
                  </TabsContent>
                </Tabs>
              </div>
            ))}
            <div className="rounded-md border">
              <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-start font-medium" onClick={() => setSeriousOpen((v) => !v)} aria-expanded={seriousOpen}>
                {t("seriousness")} <ChevronDown className={cn("size-4 transition-transform", seriousOpen && "rotate-180")} aria-hidden />
              </button>
              {seriousOpen ? (
                <ol className="list-decimal space-y-1 px-3 pb-3 ps-8">
                  <li>{t("seriousnessQ1")}</li>
                  <li>{t("seriousnessQ2")}</li>
                  <li>{t("seriousnessQ3", { total: formatDzd(order.total, locale) })}</li>
                  <li>{t("seriousnessQ4")}</li>
                </ol>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* actions */}
        <div className="space-y-4">
          {reconfirm ? (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t("reconfirmTitle")}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Input type="number" min={0} value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label={t("duration")} />
                <div className="flex flex-wrap gap-2">
                  <Button disabled={pending} onClick={() => decide("CONFIRMEE", { call: { outcome: "ANSWERED", proof: "NONE", durationSec: duration } })}>{t("reconfirm")}</Button>
                  <Button variant="outline" disabled={pending} onClick={() => setPanel("cancel")}>{t("reconfirmCancel")}</Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
          {decisionOpen ? (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t("logAttempt")}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {OUTCOMES.map((o, i) => (
                    <Button key={o} variant={(proof?.suggestedOutcome ?? "ANSWERED") === o ? "default" : "outline"} disabled={pending || !!lockedByOther || !!data.blocked} onClick={() => logOutcome(o)} data-testid={`outcome-${o}`} className="justify-start">
                      <kbd className="rounded border px-1 font-mono text-[10px]">{i + 1}</kbd> {o === "ANSWERED" ? <Phone className="size-3.5" /> : o === "OFF" ? <PhoneOff className="size-3.5" /> : null} {to(o)}
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-muted-foreground">{t("duration")}<Input type="number" min={0} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></label>
                  <label className="text-xs text-muted-foreground">{t("callbackAt")}<Input type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} /></label>
                </div>
                {proof?.proof ? (
                  <p className="text-xs text-emerald-700" data-testid="proof-received">{t("proofReceived", { source: proof.proof, duration: proof.durationSec ?? 0, outcome: proof.suggestedOutcome ? to(proof.suggestedOutcome as (typeof OUTCOMES)[number]) : "" })}</p>
                ) : callActive ? (
                  <p className="text-xs text-amber-700">{t("proofWaiting")}</p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">{t("manualProof")}</p>
                )}
                {data.nextAllowedAt ? <p className="text-[11px] text-muted-foreground">{t("nextAllowed", { time: formatDateTime(data.nextAllowedAt, locale, data.timezone) })}</p> : null}
              </CardContent>
            </Card>
          ) : null}

          {decisionOpen ? (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">{t("decision")}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <fieldset className="space-y-1.5 rounded-md border p-3" data-testid="checklist">
                  <legend className="px-1 text-xs font-medium">{t("checklist")}</legend>
                  {CHECKS.map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={!!checks[k]} onCheckedChange={(v) => setChecks((c) => ({ ...c, [k]: !!v }))} /> {tf(k)}
                    </label>
                  ))}
                  <label className="flex items-center gap-2 border-t pt-2 text-sm">
                    <Checkbox checked={upsellOn} onCheckedChange={(v) => setUpsellOn(!!v)} /> {t("upsell")}
                  </label>
                  {upsellOn ? (
                    <div className="grid grid-cols-2 gap-2">
                      <select className={selectCls} value={upsell.kind} onChange={(e) => setUpsell((u) => ({ ...u, kind: e.target.value as "UPSELL" }))} aria-label={t("upsellKindLabel")}>
                        <option value="UPSELL">{t("upsellKind.UPSELL")}</option>
                        <option value="CROSS_SELL">{t("upsellKind.CROSS_SELL")}</option>
                      </select>
                      <Input type="number" min={1} max={20} value={upsell.qty} onChange={(e) => setUpsell((u) => ({ ...u, qty: Number(e.target.value) }))} aria-label={t("qty")} />
                      <select className={cn(selectCls, "col-span-2")} value={upsell.productId} onChange={(e) => setUpsell((u) => ({ ...u, productId: e.target.value, variantId: "" }))} aria-label={t("upsellProduct")}>
                        {data.products.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatDzd(p.price, locale)}</option>)}
                      </select>
                      {productVariants.length > 0 ? (
                        <select className={cn(selectCls, "col-span-2")} value={upsell.variantId} onChange={(e) => setUpsell((u) => ({ ...u, variantId: e.target.value }))}>
                          <option value="">—</option>
                          {productVariants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      ) : null}
                    </div>
                  ) : null}
                </fieldset>
                <div className="grid grid-cols-2 gap-2 [&>button]:h-auto [&>button]:min-h-9 [&>button]:whitespace-normal [&>button]:py-1.5">
                  <Button className="col-span-2 h-11 text-base" disabled={pending || !allChecked || !answered} onClick={() => decide("CONFIRMEE", { checklist, upsells: upsellPayload })} data-testid="confirm">
                    {t("confirm")} <kbd className="ms-1 rounded border px-1 font-mono text-[10px]">C</kbd>
                  </Button>
                  <Button variant="secondary" disabled={pending || !allChecked || !answered} onClick={() => setPanel("confirmPostponed")}>{t("confirmPostponed")}</Button>
                  <Button variant="secondary" disabled={pending || !allChecked || !answered || data.stockAvailable > 0} onClick={() => decide("CONFIRMEE_RUPTURE", { checklist })}>{t("confirmOutOfStock")}</Button>
                  <Button variant="outline" disabled={pending} onClick={() => setPanel("postpone")}>{t("postpone")}</Button>
                  <Button variant="outline" disabled={pending} onClick={() => setPanel("verify")}>{t("toVerify")}</Button>
                  <Button variant="outline" disabled={pending || !answered} onClick={() => setPanel("cancel")}>{t("cancel")}</Button>
                  <Button variant="outline" disabled={pending} onClick={() => setPanel("fake")}>{t("fake")}</Button>
                </div>
                <DecisionPanel panel={panel} setPanel={setPanel} pending={pending} reconfirm={reconfirm} ar={ar} maxPostponeDays={7} confirmedMaxDays={data.settings.confirmedPostponeMaxDays} mandatoryNote={data.settings.mandatoryCancelNote}
                  onPostpone={(until, reason) => decide("REPORTE", { postponedUntil: until, reason })}
                  onConfirmPostponed={(date) => decide("CONFIRMEE_REPORTEE", { checklist, deliverOn: date })}
                  onVerify={(comment) => decide("A_VERIFIER", { comment })}
                  onCancel={(reason, note) => decide("ANNULEE", reconfirm ? { call: { outcome: "ANSWERED", proof: "NONE", durationSec: duration }, cancelReason: reason, reasonNote: note } : { cancelReason: reason, reasonNote: note })}
                  onFake={(reason, note) => start(async () => { handle(await proposeFakeQueueAction({ orderId: order.id, fakeReason: reason, note }), "next"); })}
                />
                <Button variant="ghost" size="sm" className="w-full" disabled={pending} onClick={() => start(async () => { handle(await skipAction({ orderId: order.id }), "next"); })}>
                  <SkipForward className="size-4" aria-hidden /> {t("skip")} <kbd className="ms-1 rounded border px-1 font-mono text-[10px]">S</kbd>
                </Button>
              </CardContent>
            </Card>
          ) : null}
          {!decisionOpen && reconfirm ? (
            <DecisionPanel panel={panel} setPanel={setPanel} pending={pending} reconfirm ar={ar} maxPostponeDays={7} confirmedMaxDays={30} mandatoryNote={data.settings.mandatoryCancelNote}
              onPostpone={() => undefined} onConfirmPostponed={() => undefined} onVerify={() => undefined} onFake={() => undefined}
              onCancel={(reason, note) => decide("ANNULEE", { call: { outcome: "ANSWERED", proof: "NONE", durationSec: duration }, cancelReason: reason, reasonNote: note })} />
          ) : null}
        </div>
      </div>

      {/* attempt timeline 1–9 */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{t("timeline")}</CardTitle></CardHeader>
        <CardContent>
          <ol className="grid grid-cols-3 gap-2 sm:grid-cols-9" data-testid="attempt-timeline">
            {Array.from({ length: data.settings.maxAttempts }, (_, i) => {
              const c = roundCalls.find((x) => x.attemptNo === i + 1);
              return (
                <li key={i} className={cn("rounded-md border p-2 text-xs", c ? (c.outcome === "ANSWERED" ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40" : "bg-muted") : "border-dashed text-muted-foreground")}>
                  <div className="font-mono font-semibold">#{i + 1} · J{Math.ceil((i + 1) / 3)}</div>
                  {c ? (
                    <>
                      <div>{to(c.outcome)}</div>
                      <div className="text-muted-foreground">{ts(c.slot)} · {c.phoneNumber?.label ?? "—"}</div>
                      <div className="text-muted-foreground">{formatDateTime(c.startedAt, locale, data.timezone)}</div>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
      <CommentsPanel orderId={order.id} comments={order.comments} locale={locale} timezone={data.timezone} />
    </div>
  );
}

function DecisionPanel(props: {
  panel: Panel;
  setPanel: (p: Panel) => void;
  pending: boolean;
  reconfirm: boolean;
  ar: boolean;
  maxPostponeDays: number;
  confirmedMaxDays: number;
  mandatoryNote: boolean;
  onPostpone: (until: string, reason: string) => void;
  onConfirmPostponed: (date: string) => void;
  onVerify: (comment: string) => void;
  onCancel: (reason: string, note?: string) => void;
  onFake: (reason: string, note: string) => void;
}) {
  const t = useTranslations("call");
  const tf = useTranslations("transition.fields");
  const tc = useTranslations("common");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [min] = useState(() => new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 16));
  if (!props.panel) return null;
  const close = () => {
    props.setPanel(null);
    setA("");
    setB("");
  };
  const lang = (l: { fr: string; ar: string }) => (props.ar ? l.ar : l.fr);
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3" data-testid={`panel-${props.panel}`}>
      {props.panel === "postpone" ? (
        <>
          <label className="text-xs">{tf("postponedUntil")}<Input type="datetime-local" min={min} value={a} onChange={(e) => setA(e.target.value)} /></label>
          <label className="text-xs">{tf("reason")}<Input value={b} onChange={(e) => setB(e.target.value)} /></label>
          <Button size="sm" disabled={props.pending || !a || b.trim().length < 2} onClick={() => props.onPostpone(new Date(a).toISOString(), b)}>{tc("confirm")}</Button>
        </>
      ) : null}
      {props.panel === "confirmPostponed" ? (
        <>
          <label className="text-xs">{tf("deliverOn")}<Input type="date" min={min.slice(0, 10)} value={a} onChange={(e) => setA(e.target.value)} /></label>
          <Button size="sm" disabled={props.pending || !a} onClick={() => props.onConfirmPostponed(new Date(`${a}T10:00:00`).toISOString())}>{tc("confirm")}</Button>
        </>
      ) : null}
      {props.panel === "verify" ? (
        <>
          <Textarea rows={2} placeholder={tf("comment")} value={a} onChange={(e) => setA(e.target.value)} />
          <Button size="sm" disabled={props.pending || a.trim().length < 3} onClick={() => props.onVerify(a)}>{tc("confirm")}</Button>
        </>
      ) : null}
      {props.panel === "cancel" ? (
        <>
          <select className={selectCls} value={a} onChange={(e) => setA(e.target.value)} aria-label={tf("cancelReason")}>
            <option value="">{tf("cancelReason")}</option>
            {Object.entries(CANCEL_REASON_LABELS).map(([code, l]) => <option key={code} value={code}>{lang(l)}</option>)}
          </select>
          <Textarea rows={2} placeholder={tf("reasonNote")} value={b} onChange={(e) => setB(e.target.value)} />
          <Button size="sm" variant="destructive" disabled={props.pending || !a || ((a === "OTHER" || props.mandatoryNote) && !b.trim())} onClick={() => props.onCancel(a, b || undefined)}>{t("cancel")}</Button>
        </>
      ) : null}
      {props.panel === "fake" ? (
        <>
          <select className={selectCls} value={a} onChange={(e) => setA(e.target.value)} aria-label={tf("fakeReason")}>
            <option value="">{tf("fakeReason")}</option>
            {Object.entries(FAKE_REASON_LABELS).map(([code, l]) => <option key={code} value={code}>{lang(l)}</option>)}
          </select>
          <Textarea rows={2} placeholder={tf("note")} value={b} onChange={(e) => setB(e.target.value)} />
          <Button size="sm" variant="destructive" disabled={props.pending || !a || b.trim().length < 2} onClick={() => props.onFake(a, b)}>{t("fake")}</Button>
        </>
      ) : null}
      <Button size="sm" variant="ghost" onClick={close}>{tc("cancel")}</Button>
    </div>
  );
}
