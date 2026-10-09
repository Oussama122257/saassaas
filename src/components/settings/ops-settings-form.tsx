"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { OrgSettings } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { saveNumberAction, saveOpsSettingsAction } from "@/app/[locale]/(app)/settings/operations/actions";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const windowsToText = (w: Array<[number, number]>) => w.map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`).join(", ");
const textToWindows = (s: string): Array<[number, number]> =>
  s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [a, b] = x.split("-");
    return [toMin(a ?? "0:00"), toMin(b ?? "0:00")] as [number, number];
  });
const selectCls = "h-9 rounded-md border bg-background px-2 text-sm";

interface Props {
  orgId: string;
  settings: OrgSettings;
  merchants: Array<{ id: string; name: string; settings: OrgSettings }>;
  numbers: Array<{ id: string; label: string; msisdn: string; active: boolean; answerRate: number | null; burnedAt: string | null }>;
  agents: Array<{ id: string; name: string }>;
}

function Num({ label, value, onChange, min = 0 }: { label: string; value: number; onChange: (n: number) => void; min?: number }) {
  return (
    <label className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input type="number" min={min} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function OpsSettingsForm({ orgId, settings, merchants, numbers, agents }: Props) {
  const t = useTranslations("ops");
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [prayer, setPrayer] = useState(windowsToText(settings.calls.prayerWindows));
  const [percents, setPercents] = useState<Record<string, number>>(settings.assignment.distribution?.percents ?? Object.fromEntries(agents.map((a) => [a.id, Math.floor(100 / Math.max(1, agents.length))])));
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? "");
  const [intake, setIntake] = useState(merchants[0]?.settings.intake ?? settings.intake);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [newNum, setNewNum] = useState({ label: "", msisdn: "" });
  const [pending, start] = useTransition();
  const save = (section: string, orgTarget: string, patch: Record<string, unknown>) =>
    start(async () => {
      const r = await saveOpsSettingsAction({ orgId: orgTarget, patch });
      setMsg((m) => ({ ...m, [section]: r.ok ? t("saved") : r.message }));
      if (r.ok) router.refresh();
    });
  const c = s.calls;
  const setCalls = (patch: Partial<OrgSettings["calls"]>) => setS((x) => ({ ...x, calls: { ...x.calls, ...patch } }));
  const setLife = (patch: Partial<OrgSettings["lifecycle"]>) => setS((x) => ({ ...x, lifecycle: { ...x.lifecycle, ...patch } }));
  const setAssign = (patch: Partial<OrgSettings["assignment"]>) => setS((x) => ({ ...x, assignment: { ...x.assignment, ...patch } }));
  const total = Object.values(percents).reduce((a, b) => a + b, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">{t("cadence")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Num label={t("minGap")} value={c.minAttemptGapMin} onChange={(v) => setCalls({ minAttemptGapMin: v })} />
            <Num label={t("cadenceGap")} value={c.cadenceGapMin} onChange={(v) => setCalls({ cadenceGapMin: v })} />
            <Num label={t("firstCall")} value={c.firstCallWithinMin} onChange={(v) => setCalls({ firstCallWithinMin: v })} min={1} />
            <Num label={t("maxPerRound")} value={c.maxAttemptsPerRound} onChange={(v) => setCalls({ maxAttemptsPerRound: v })} min={3} />
            <Num label={t("maxTotal")} value={c.maxAttemptsTotal} onChange={(v) => setCalls({ maxAttemptsTotal: v })} min={3} />
            <Num label={t("minSpaced")} value={c.minSpacedAttemptsToClose} onChange={(v) => setCalls({ minSpacedAttemptsToClose: v })} />
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={c.strictSlots} onCheckedChange={(v) => setCalls({ strictSlots: !!v })} /> {t("strictSlots")}</label>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {(["MORNING", "AFTERNOON", "EVENING"] as const).map((slot) => (
              <div key={slot} className="space-y-1">
                <span className="text-muted-foreground">{t(`slot.${slot}`)}</span>
                <div className="flex gap-1">
                  <Input type="time" value={hhmm(c.slots[slot][0])} onChange={(e) => setCalls({ slots: { ...c.slots, [slot]: [toMin(e.target.value), c.slots[slot][1]] } })} />
                  <Input type="time" value={hhmm(c.slots[slot][1])} onChange={(e) => setCalls({ slots: { ...c.slots, [slot]: [c.slots[slot][0], toMin(e.target.value)] } })} />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-1"><span className="text-muted-foreground">{t("dayStart")}</span><Input type="time" value={hhmm(c.dayStartMin)} onChange={(e) => setCalls({ dayStartMin: toMin(e.target.value) })} /></label>
            <label className="space-y-1"><span className="text-muted-foreground">{t("dayEnd")}</span><Input type="time" value={hhmm(c.dayEndMin)} onChange={(e) => setCalls({ dayEndMin: toMin(e.target.value) })} /></label>
            <label className="col-span-2 space-y-1"><span className="text-muted-foreground">{t("prayer")}</span><Input value={prayer} onChange={(e) => setPrayer(e.target.value)} placeholder="12:45-13:15, 16:00-16:15" dir="ltr" /></label>
            <label className="col-span-2 flex items-center gap-2"><Checkbox checked={!!c.fridayBlock} onCheckedChange={(v) => setCalls({ fridayBlock: v ? [720, 870] : null })} /> {t("friday")}</label>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-3">
            <Num label={t("minAnswered")} value={s.minAnsweredCallSec} onChange={(v) => setS((x) => ({ ...x, minAnsweredCallSec: v }))} />
            <Num label={t("highValue")} value={s.highValueThreshold} onChange={(v) => setS((x) => ({ ...x, highValueThreshold: v }))} />
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={s.manualCallProof} onCheckedChange={(v) => setS((x) => ({ ...x, manualCallProof: !!v }))} /> {t("manualProof")}</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={s.mandatoryCancelNote} onCheckedChange={(v) => setS((x) => ({ ...x, mandatoryCancelNote: !!v }))} /> {t("mandatoryNote")}</label>
          <Button disabled={pending} onClick={() => save("calls", orgId, { calls: { ...c, prayerWindows: textToWindows(prayer) }, minAnsweredCallSec: s.minAnsweredCallSec, highValueThreshold: s.highValueThreshold, manualCallProof: s.manualCallProof, mandatoryCancelNote: s.mandatoryCancelNote })}>{t("save")}</Button>
          {msg.calls ? <p className="text-sm text-muted-foreground">{msg.calls}</p> : null}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">{t("lifecycle")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Num label={t("lockTimeout")} value={s.lifecycle.lockTimeoutMin} onChange={(v) => setLife({ lockTimeoutMin: v })} min={1} />
              <Num label={t("untouched")} value={s.lifecycle.untouchedReassignMin} onChange={(v) => setLife({ untouchedReassignMin: v })} min={1} />
              <Num label={t("expiryDays")} value={s.lifecycle.expiryDays} onChange={(v) => setLife({ expiryDays: v })} min={1} />
              <Num label={t("recycleCooldown")} value={s.lifecycle.recycleCooldownDays} onChange={(v) => setLife({ recycleCooldownDays: v })} />
              <Num label={t("recycleRounds")} value={s.lifecycle.maxRecycleRounds} onChange={(v) => setLife({ maxRecycleRounds: v })} />
            </div>
            <Button disabled={pending} onClick={() => save("life", orgId, { lifecycle: s.lifecycle })}>{t("save")}</Button>
            {msg.life ? <p className="text-sm text-muted-foreground">{msg.life}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">{t("assignment")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1 text-xs"><span className="text-muted-foreground">{t("strategy")}</span>
                <select className={selectCls} value={s.assignment.strategy} onChange={(e) => setAssign({ strategy: e.target.value as "LOAD_BALANCED" })}>
                  <option value="LOAD_BALANCED">{t("loadBalanced")}</option>
                  <option value="PERCENTAGE">{t("percentage")}</option>
                </select>
              </label>
              <Num label={t("cap")} value={s.assignment.maxOpenOrdersPerAgent} onChange={(v) => setAssign({ maxOpenOrdersPerAgent: v })} min={1} />
            </div>
            {s.assignment.strategy === "PERCENTAGE" ? (
              <div className="space-y-1 rounded-md border p-2">
                {agents.map((a) => (
                  <label key={a.id} className="flex items-center justify-between gap-2">{a.name}<Input type="number" className="w-24" min={0} max={100} value={percents[a.id] ?? 0} onChange={(e) => setPercents((p) => ({ ...p, [a.id]: Number(e.target.value) }))} /></label>
                ))}
                <p className={total === 100 ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{t("totalPercent", { total })}</p>
              </div>
            ) : null}
            <label className="flex items-center gap-2"><Checkbox checked={s.assignment.ownershipLock} onCheckedChange={(v) => setAssign({ ownershipLock: !!v })} /> {t("ownershipLock")}</label>
            <label className="flex items-center gap-2"><Checkbox checked={s.assignment.highValueToTopAgents} onCheckedChange={(v) => setAssign({ highValueToTopAgents: !!v })} /> {t("topAgents")}</label>
            <label className="flex items-center gap-2"><Checkbox checked={s.assignment.requireShift} onCheckedChange={(v) => setAssign({ requireShift: !!v })} /> {t("requireShift")}</label>
            <Button disabled={pending} onClick={() => save("assign", orgId, { assignment: { ...s.assignment, distribution: s.assignment.strategy === "PERCENTAGE" ? { savedAt: new Date().toISOString(), percents } : s.assignment.distribution } })}>{t("save")}</Button>
            {msg.assign ? <p className="text-sm text-muted-foreground">{msg.assign}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">{t("intake")}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {merchants.length > 1 ? (
              <select className={selectCls} value={merchantId} onChange={(e) => { setMerchantId(e.target.value); setIntake(merchants.find((m) => m.id === e.target.value)!.settings.intake); }}>
                {merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            ) : null}
            <label className="flex items-center gap-2"><Checkbox checked={intake.ipLimitEnabled} onCheckedChange={(v) => setIntake((x) => ({ ...x, ipLimitEnabled: !!v }))} /> {t("ipLimit")}</label>
            <div className="grid grid-cols-3 gap-3">
              <Num label={t("ipMax")} value={intake.ipLimitMax} onChange={(v) => setIntake((x) => ({ ...x, ipLimitMax: v }))} min={1} />
              <Num label={t("ipHours")} value={intake.ipLimitHours} onChange={(v) => setIntake((x) => ({ ...x, ipLimitHours: v }))} min={1} />
              <Num label={t("dupWindow")} value={intake.duplicateWindowHours} onChange={(v) => setIntake((x) => ({ ...x, duplicateWindowHours: v }))} min={1} />
            </div>
            <p className="text-xs text-muted-foreground">{t("ipHint")}</p>
            <label className="space-y-1 text-xs"><span className="text-muted-foreground">{t("blacklistMode")}</span>
              <select className={selectCls} value={intake.blacklistMode} onChange={(e) => setIntake((x) => ({ ...x, blacklistMode: e.target.value as "FLAG" }))}>
                <option value="FLAG">{t("blacklistFlag")}</option>
                <option value="REFUSE">{t("blacklistRefuse")}</option>
              </select>
            </label>
            <Button disabled={pending || !merchantId} onClick={() => save("intake", merchantId, { intake })}>{t("save")}</Button>
            {msg.intake ? <p className="text-sm text-muted-foreground">{msg.intake}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">{t("numbers")}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground">{t("numbersHint")}</p>
            {numbers.map((n) => (
              <div key={n.id} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{n.label}</Badge>
                <span className="font-mono" dir="ltr">{n.msisdn}</span>
                <span className="text-xs text-muted-foreground">{n.answerRate !== null ? `${Math.round(n.answerRate * 100)}%` : "—"}</span>
                {n.burnedAt ? <Badge variant="destructive">{t("burned")}</Badge> : null}
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await saveNumberAction({ id: n.id, label: n.label, msisdn: n.msisdn, active: !n.active }); router.refresh(); })}>{n.active ? t("deactivate") : t("activate")}</Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input className="w-16" placeholder="D" value={newNum.label} onChange={(e) => setNewNum((x) => ({ ...x, label: e.target.value }))} />
              <Input className="w-48" placeholder="0550 00 00 00" value={newNum.msisdn} onChange={(e) => setNewNum((x) => ({ ...x, msisdn: e.target.value }))} dir="ltr" />
              <Button size="sm" disabled={pending || !newNum.msisdn} onClick={() => start(async () => { const r = await saveNumberAction({ label: newNum.label, msisdn: newNum.msisdn, active: true }); setMsg((m) => ({ ...m, numbers: r.ok ? t("saved") : r.message })); setNewNum({ label: "", msisdn: "" }); router.refresh(); })}>{t("add")}</Button>
            </div>
            {msg.numbers ? <p className="text-sm text-muted-foreground">{msg.numbers}</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
