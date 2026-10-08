"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { OrderStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { overrideAction, transitionAction, type ActionResult } from "@/app/[locale]/(app)/orders/actions";
import { CANCEL_REASON_LABELS, RETURN_REASON_LABELS } from "@/lib/orders/statuses";

export interface TargetOption {
  to: OrderStatus;
  ruleId: string;
  label: string;
}

interface Props {
  locale: string;
  orderId: string;
  targets: TargetOption[];
  canOverride: boolean;
  overrideOptions: Array<{ code: OrderStatus; label: string }>;
  agents: Array<{ id: string; name: string }>;
}

const selectCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function StatusChangeDialog({ locale, orderId, targets, canOverride, overrideOptions, agents }: Props) {
  const t = useTranslations("transition");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<TargetOption | null>(targets[0] ?? null);
  const [overrideTo, setOverrideTo] = useState<OrderStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const handle = (res: ActionResult) => {
    if (res.ok) {
      setOpen(false);
      setError(null);
      router.refresh();
    } else {
      const key = `errors.${res.code}` as Parameters<typeof t>[0];
      setError(t.has(key) ? t(key, { detail: res.detail ?? res.message }) : res.message);
    }
  };

  const submitTransition = (form: HTMLFormElement) => {
    if (!target) return;
    const payload = buildPayload(target.ruleId, new FormData(form));
    start(async () => handle(await transitionAction({ locale, orderId, to: target.to, payload })));
  };

  const submitOverride = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    if (!overrideTo) return;
    start(async () => handle(await overrideAction({ locale, orderId, to: overrideTo, reason: String(fd.get("reason") ?? "") })));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button data-testid="change-status">{t("changeStatus")}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("changeStatus")}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={targets.length > 0 || !canOverride ? "transition" : "override"}>
          {canOverride ? (
            <TabsList className="w-full">
              <TabsTrigger value="transition" className="flex-1">{t("newStatus")}</TabsTrigger>
              <TabsTrigger value="override" className="flex-1">{t("override")}</TabsTrigger>
            </TabsList>
          ) : null}
          <TabsContent value="transition">
            {targets.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{t("noActions")}</p>
            ) : (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submitTransition(e.currentTarget); }} data-testid="transition-form">
                <Field label={t("newStatus")}>
                  <select className={selectCls} value={target?.to ?? ""} onChange={(e) => setTarget(targets.find((x) => x.to === e.target.value) ?? null)} name="to" data-testid="target-status">
                    {targets.map((o) => (
                      <option key={o.to} value={o.to}>{o.label}</option>
                    ))}
                  </select>
                </Field>
                {target ? <RuleFields ruleId={target.ruleId} agents={agents} /> : null}
                {error ? <Alert variant="destructive" data-testid="transition-error"><AlertDescription>{error}</AlertDescription></Alert> : null}
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
                  <Button type="submit" disabled={pending || !target}>{pending ? t("applying") : t("apply")}</Button>
                </DialogFooter>
              </form>
            )}
          </TabsContent>
          {canOverride ? (
            <TabsContent value="override">
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submitOverride(e.currentTarget); }} data-testid="override-form">
                <Alert><AlertDescription>{t("overrideWarning")}</AlertDescription></Alert>
                <Field label={t("newStatus")}>
                  <select className={selectCls} value={overrideTo} onChange={(e) => setOverrideTo(e.target.value as OrderStatus)} required data-testid="override-status">
                    <option value="">—</option>
                    {overrideOptions.map((o) => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t("overrideReason")}>
                  <Textarea name="reason" required minLength={5} placeholder={t("overrideReasonPlaceholder")} />
                </Field>
                {error ? <Alert variant="destructive" data-testid="transition-error"><AlertDescription>{error}</AlertDescription></Alert> : null}
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
                  <Button type="submit" variant="destructive" disabled={pending || !overrideTo}>{pending ? t("applying") : t("apply")}</Button>
                </DialogFooter>
              </form>
            </TabsContent>
          ) : null}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RuleFields({ ruleId, agents }: { ruleId: string; agents: Array<{ id: string; name: string }> }) {
  const t = useTranslations("transition.fields");
  const to = useTranslations("order.outcome");
  const tp = useTranslations("order.proof");
  const [outcome, setOutcome] = useState("ANSWERED");
  const [dateTimeMin] = useState(() => new Date(Date.now() + 60_000).toISOString().slice(0, 16));

  switch (ruleId) {
    case "LOG_CALL":
      return (
        <>
          <Field label={t("outcome")}>
            <select name="outcome" className={selectCls} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {(["ANSWERED", "NO_ANSWER", "BUSY", "OFF", "WRONG_NUMBER", "CALLBACK_REQUESTED"] as const).map((o) => (
                <option key={o} value={o}>{to(o)}</option>
              ))}
            </select>
          </Field>
          <Field label={t("proof")}>
            <select name="proof" className={selectCls} defaultValue="DEVICE_LOG">
              {(["DEVICE_LOG", "VOIP_LOG", "NONE"] as const).map((p) => (
                <option key={p} value={p}>{tp(p)}</option>
              ))}
            </select>
          </Field>
          <Field label={t("durationSec")}>
            <Input name="durationSec" type="number" min={0} defaultValue={outcome === "ANSWERED" ? 30 : 0} />
          </Field>
          {outcome === "CALLBACK_REQUESTED" ? (
            <Field label={t("callbackAt")}>
              <Input name="callbackAt" type="datetime-local" min={dateTimeMin} required />
            </Field>
          ) : null}
          <Field label={t("callNote")}>
            <Textarea name="callNote" rows={2} />
          </Field>
        </>
      );
    case "CONFIRM":
    case "CONFIRM_OUT_OF_STOCK":
      return (
        <fieldset className="space-y-2 rounded-md border p-3" data-testid="checklist">
          <legend className="px-1 text-sm font-medium">{t("checklist")}</legend>
          {(["productExplained", "totalStated", "addressVerified", "variantVerified", "explicitYes"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <Checkbox name={k} value="1" /> {t(k)}
            </label>
          ))}
          <Field label={t("note")}>
            <Textarea name="note" rows={2} />
          </Field>
        </fieldset>
      );
    case "CANCEL":
      return (
        <>
          <Field label={t("cancelReason")}>
            <select name="cancelReason" className={selectCls} required defaultValue="">
              <option value="" disabled>—</option>
              {Object.entries(CANCEL_REASON_LABELS).map(([code, l]) => (
                <option key={code} value={code}>{l.fr} / {l.ar}</option>
              ))}
            </select>
          </Field>
          <Field label={t("reasonNote")}>
            <Textarea name="reasonNote" rows={2} />
          </Field>
        </>
      );
    case "POSTPONE":
      return (
        <>
          <Field label={t("postponedUntil")}>
            <Input name="postponedUntil" type="datetime-local" min={dateTimeMin} required />
          </Field>
          <Field label={t("reason")}>
            <Input name="reason" required minLength={2} />
          </Field>
        </>
      );
    case "TO_VERIFY":
      return (
        <Field label={t("comment")}>
          <Textarea name="comment" required minLength={3} rows={3} />
        </Field>
      );
    case "DUPLICATE_MERGE":
    case "DUPLICATE_REOPEN":
      return (
        <Field label={t("verificationNote")}>
          <Textarea name="verificationNote" required minLength={2} rows={2} />
        </Field>
      );
    case "FAKE_ORDER":
      return (
        <>
          <Field label={t("note")}>
            <Textarea name="note" rows={2} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="blacklistRequest" value="1" /> {t("blacklistRequest")}
          </label>
        </>
      );
    case "SHIPPED":
      return (
        <Field label={t("trackingNumber")}>
          <Input name="trackingNumber" required minLength={2} dir="ltr" />
        </Field>
      );
    case "RETURN_RECEIVED":
      return (
        <>
          <Field label={t("condition")}>
            <select name="condition" className={selectCls} defaultValue="OK">
              <option value="OK">{t("conditionOK")}</option>
              <option value="DAMAGED">{t("conditionDAMAGED")}</option>
              <option value="MISSING">{t("conditionMISSING")}</option>
            </select>
          </Field>
          <Field label={t("note")}>
            <Textarea name="note" rows={2} />
          </Field>
        </>
      );
    case "RETURN_STARTED":
      return (
        <>
          <Field label={t("returnReason")}>
            <select name="returnReason" className={selectCls} required defaultValue="">
              <option value="" disabled>—</option>
              {Object.entries(RETURN_REASON_LABELS).map(([code, l]) => (
                <option key={code} value={code}>{l.fr} / {l.ar}</option>
              ))}
            </select>
          </Field>
          <Field label={t("reasonNote")}>
            <Textarea name="reasonNote" rows={2} />
          </Field>
        </>
      );
    case "LOST_OR_DAMAGED":
      return (
        <Field label={t("note")}>
          <Textarea name="note" required minLength={2} rows={2} />
        </Field>
      );
    case "CASH_COLLECTED":
      return (
        <Field label={t("amount")}>
          <Input name="amount" type="number" min={0} />
        </Field>
      );
    case "ASSIGN":
      return (
        <Field label={t("assignedToId")}>
          <select name="assignedToId" className={selectCls} required defaultValue={agents[0]?.id ?? ""}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </Field>
      );
    default:
      return null;
  }
}

/** Translate the dialog's form fields into the payload shape expected by the transition's Zod schema. */
export function buildPayload(ruleId: string, fd: FormData): Record<string, unknown> {
  const str = (k: string) => {
    const v = fd.get(k);
    return v === null || v === "" ? undefined : String(v);
  };
  const num = (k: string) => {
    const v = str(k);
    return v === undefined ? undefined : Number(v);
  };
  const bool = (k: string) => fd.get(k) === "1" || fd.get(k) === "on";
  switch (ruleId) {
    case "LOG_CALL":
      return {
        call: {
          outcome: str("outcome"),
          proof: str("proof"),
          durationSec: num("durationSec"),
          callbackAt: str("callbackAt") ? new Date(String(str("callbackAt"))).toISOString() : undefined,
          note: str("callNote"),
        },
      };
    case "CONFIRM":
    case "CONFIRM_OUT_OF_STOCK":
      return {
        checklist: {
          productExplained: bool("productExplained"),
          totalStated: bool("totalStated"),
          addressVerified: bool("addressVerified"),
          variantVerified: bool("variantVerified"),
          explicitYes: bool("explicitYes"),
        },
        note: str("note"),
      };
    case "CANCEL":
      return { cancelReason: str("cancelReason"), reasonNote: str("reasonNote") };
    case "POSTPONE":
      return { postponedUntil: str("postponedUntil") ? new Date(String(str("postponedUntil"))).toISOString() : undefined, reason: str("reason") };
    case "TO_VERIFY":
      return { comment: str("comment") };
    case "DUPLICATE_MERGE":
    case "DUPLICATE_REOPEN":
      return { verificationNote: str("verificationNote") };
    case "FAKE_ORDER":
      return { note: str("note"), blacklistRequest: bool("blacklistRequest") };
    case "SHIPPED":
      return { trackingNumber: str("trackingNumber") };
    case "RETURN_RECEIVED":
      return { condition: str("condition"), note: str("note") };
    case "RETURN_STARTED":
      return { returnReason: str("returnReason"), reasonNote: str("reasonNote") };
    case "LOST_OR_DAMAGED":
      return { note: str("note") };
    case "CASH_COLLECTED":
      return { amount: num("amount") };
    case "ASSIGN":
      return { assignedToId: str("assignedToId"), rule: "MANUAL" };
    default:
      return {};
  }
}
