"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { MessagingSettings, OrgSettings } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveOpsSettingsAction } from "@/app/[locale]/(app)/settings/operations/actions";
import { saveTemplateAction, topUpCreditsAction } from "@/app/[locale]/(app)/settings/messaging/actions";

const selectCls = "h-9 rounded-md border bg-background px-2 text-sm";
type Tpl = { key: string; channel: string; lang: string; body: string; waTemplateName: string | null; waLanguage: string | null; active: boolean };

interface Props {
  merchants: Array<{ id: string; name: string }>;
  merchantId: string;
  teamOrgId: string;
  messaging: MessagingSettings;
  telephony: OrgSettings["telephony"];
  templates: Tpl[];
  defaults: Record<string, { fr: string; ar: string }>;
  balance: number;
  isPlatformAdmin: boolean;
}

export function MessagingSettingsForm(p: Props) {
  const t = useTranslations("messaging");
  const router = useRouter();
  const [m, setM] = useState(p.messaging);
  const [tel, setTel] = useState(p.telephony);
  const [key, setKey] = useState(Object.keys(p.defaults)[0]!);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  const [lang, setLang] = useState<"fr" | "ar">("ar");
  const current = p.templates.find((x) => x.key === key && x.channel === channel && x.lang === lang);
  const [body, setBody] = useState(current?.body ?? "");
  const [waName, setWaName] = useState(current?.waTemplateName ?? "");
  const [amount, setAmount] = useState(500);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pick = (k: string, c: "WHATSAPP" | "SMS", l: "fr" | "ar") => {
    setKey(k);
    setChannel(c);
    setLang(l);
    const x = p.templates.find((y) => y.key === k && y.channel === c && y.lang === l);
    setBody(x?.body ?? "");
    setWaName(x?.waTemplateName ?? "");
  };
  const done = (r: { ok: boolean; message?: string }) => {
    setMsg(r.ok ? t("saved") : r.message ?? "error");
    if (r.ok) router.refresh();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">{t("automation")}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {p.merchants.length > 1 ? (
            <select className={selectCls} value={p.merchantId} onChange={(e) => router.push(`/settings/messaging?merchant=${e.target.value}`)}>
              {p.merchants.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          ) : null}
          <div className="text-2xl font-semibold tabular-nums" data-testid="credit-balance">{t("balance", { n: p.balance })}</div>
          <label className="flex items-center gap-2"><Checkbox checked={m.botConfirmation} onCheckedChange={(v) => setM((x) => ({ ...x, botConfirmation: !!v }))} /> {t("botConfirmation")}</label>
          <label className="flex items-center gap-2">{t("language")}
            <select className={selectCls} value={m.language} onChange={(e) => setM((x) => ({ ...x, language: e.target.value as "ar" }))}><option value="ar">العربية / Darija</option><option value="fr">Français</option></select>
          </label>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{t("enabledTemplates")}</div>
            <div className="grid grid-cols-2 gap-1">
              {Object.keys(p.defaults).map((k) => (
                <label key={k} className="flex items-center gap-2 font-mono text-xs"><Checkbox checked={!m.disabledTemplates.includes(k)} onCheckedChange={(v) => setM((x) => ({ ...x, disabledTemplates: v ? x.disabledTemplates.filter((y) => y !== k) : [...x.disabledTemplates, k] }))} /> {k}</label>
              ))}
            </div>
          </div>
          <Button disabled={pending} onClick={() => start(async () => done(await saveOpsSettingsAction({ orgId: p.merchantId, patch: { messaging: { botConfirmation: m.botConfirmation, language: m.language, disabledTemplates: m.disabledTemplates } } })))}>{t("save")}</Button>
          {p.isPlatformAdmin ? (
            <div className="flex items-end gap-2 border-t pt-3">
              <label className="text-xs">{t("topUp")}<Input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></label>
              <Button variant="outline" disabled={pending} onClick={() => start(async () => done(await topUpCreditsAction({ orgId: p.merchantId, amount })))}>{t("credit")}</Button>
            </div>
          ) : null}
          <div className="space-y-2 border-t pt-3">
            <div className="font-medium">{t("telephony")}</div>
            <select className={selectCls} value={tel.mode} onChange={(e) => setTel((x) => ({ ...x, mode: e.target.value as "DEVICE" }))}>
              <option value="DEVICE">{t("modeDevice")}</option>
              <option value="VOIP">{t("modeVoip")}</option>
              <option value="MANUAL">{t("modeManual")}</option>
            </select>
            <Button variant="outline" disabled={pending} onClick={() => start(async () => done(await saveOpsSettingsAction({ orgId: p.teamOrgId, patch: { telephony: tel } })))}>{t("save")}</Button>
          </div>
          {msg ? <p className="text-muted-foreground">{msg}</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">{t("templates")}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <select className={selectCls} value={key} onChange={(e) => pick(e.target.value, channel, lang)}>{Object.keys(p.defaults).map((k) => <option key={k} value={k}>{k}</option>)}</select>
            <select className={selectCls} value={channel} onChange={(e) => pick(key, e.target.value as "SMS", lang)}><option value="WHATSAPP">WhatsApp</option><option value="SMS">SMS</option></select>
            <select className={selectCls} value={lang} onChange={(e) => pick(key, channel, e.target.value as "fr")}><option value="ar">AR</option><option value="fr">FR</option></select>
          </div>
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder={p.defaults[key]?.[lang]} dir={lang === "ar" ? "rtl" : "ltr"} />
          <p className="text-xs text-muted-foreground">{t("variables")}</p>
          {channel === "WHATSAPP" ? <Input placeholder={t("waTemplate")} value={waName} onChange={(e) => setWaName(e.target.value)} dir="ltr" /> : null}
          <Button disabled={pending} onClick={() => start(async () => done(await saveTemplateAction({ merchantId: p.merchantId, key, channel, lang, body, waTemplateName: waName, waLanguage: lang, active: true })))}>{t("saveTemplate")}</Button>
        </CardContent>
      </Card>
    </div>
  );
}
