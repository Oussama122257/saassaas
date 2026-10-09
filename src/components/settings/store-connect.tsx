"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { connectDzbuildAction, connectSheetAction, rotateIntakeAction, saveShopifyAppAction, syncNowAction } from "@/app/[locale]/(app)/settings/stores/actions";

interface Props {
  store: { id: string; channel: string; externalRef: string | null; hasToken: boolean; sheetConnected: boolean; hasIntakeToken: boolean };
  appUrl: string;
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <code className="block break-all rounded bg-muted p-2 text-xs" dir="ltr">{value}</code>
    </div>
  );
}

export function StoreConnect({ store, appUrl }: Props) {
  const t = useTranslations("stores");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secrets, setSecrets] = useState<Array<[string, string]>>([]);
  const [shop, setShop] = useState(store.externalRef ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [dzKey, setDzKey] = useState("");
  const [sheetUrl, setSheetUrl] = useState(store.externalRef ? `https://docs.google.com/spreadsheets/d/${store.externalRef}` : "");
  const [hasHeader, setHasHeader] = useState(true);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t("connect")}</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {store.channel === "SHOPIFY" ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">{t("shopifyHelp")}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input placeholder="my-store.myshopify.com" value={shop} onChange={(e) => setShop(e.target.value)} dir="ltr" />
              <Input placeholder={t("clientId")} value={apiKey} onChange={(e) => setApiKey(e.target.value)} dir="ltr" />
              <Input placeholder={t("clientSecret")} type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} dir="ltr" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={pending || !shop} onClick={() => start(async () => {
                const r = await saveShopifyAppAction({ storeId: store.id, shop, apiKey, apiSecret });
                if (r.ok && r.data) window.location.href = r.data.installUrl;
                else if (!r.ok) setMsg({ ok: false, text: r.message });
              })}>{store.hasToken ? t("reinstall") : t("install")}</Button>
              {store.hasToken ? <Button variant="outline" disabled={pending} onClick={() => start(async () => { const r = await syncNowAction({ storeId: store.id }); setMsg(r.ok ? { ok: true, text: t("backfillQueued") } : { ok: false, text: r.message }); })}>{t("backfill")}</Button> : null}
            </div>
            <Secret label={t("webhookEndpoint")} value={`${appUrl}/api/webhooks/shopify`} />
          </div>
        ) : null}

        {store.channel === "DZBUILD" ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">{t("dzbuildHelp")}</p>
            <div className="flex flex-wrap gap-2">
              <Input className="max-w-md" placeholder="key_id.key_secret" type="password" value={dzKey} onChange={(e) => setDzKey(e.target.value)} dir="ltr" />
              <Button disabled={pending || !dzKey} onClick={() => start(async () => {
                const r = await connectDzbuildAction({ storeId: store.id, apiKey: dzKey });
                if (r.ok && r.data) {
                  setSecrets([[t("webhookUrl"), r.data.webhookUrl], [t("webhookSecret"), r.data.webhookSecret]]);
                  setMsg({ ok: true, text: `${t("testOk")} — scopes: ${r.data.scopes.join(", ")}` });
                  router.refresh();
                } else if (!r.ok) setMsg({ ok: false, text: r.message });
              })}>{t("testAndSave")}</Button>
              {store.hasToken ? <Button variant="outline" disabled={pending} onClick={() => start(async () => { const r = await syncNowAction({ storeId: store.id }); setMsg(r.ok ? { ok: true, text: JSON.stringify(r.data) } : { ok: false, text: r.message }); })}>{t("syncNow")}</Button> : null}
            </div>
          </div>
        ) : null}

        {store.channel === "GOOGLE_SHEET" ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">{t("sheetHelp")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="max-w-xl" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} dir="ltr" />
              <label className="flex items-center gap-1 text-xs"><Checkbox checked={hasHeader} onCheckedChange={(v) => setHasHeader(!!v)} /> {t("hasHeader")}</label>
              <Button disabled={pending || !sheetUrl} onClick={() => start(async () => { const r = await connectSheetAction({ storeId: store.id, url: sheetUrl, hasHeader }); setMsg(r.ok ? { ok: true, text: `${t("testOk")} — ${r.data?.rows} rows` } : { ok: false, text: r.message }); router.refresh(); })}>{t("testAndSave")}</Button>
              {store.sheetConnected ? <Button variant="outline" disabled={pending} onClick={() => start(async () => { const r = await syncNowAction({ storeId: store.id }); setMsg(r.ok ? { ok: true, text: JSON.stringify(r.data) } : { ok: false, text: r.message }); })}>{t("syncNow")}</Button> : null}
            </div>
          </div>
        ) : null}

        <div className="space-y-2 border-t pt-3">
          <p className="font-medium">{t("intakeTitle")}</p>
          <p className="text-muted-foreground">{t("intakeHelp")}</p>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => {
            const r = await rotateIntakeAction({ storeId: store.id });
            if (r.ok && r.data) {
              const list: Array<[string, string]> = [[t("intakeUrl"), r.data.intakeUrl], [t("intakeToken"), r.data.token]];
              if (r.data.webhookSecret) list.push([t("genericWebhookUrl"), r.data.webhookUrl], [t("webhookSecret"), r.data.webhookSecret]);
              setSecrets(list);
            } else if (!r.ok) setMsg({ ok: false, text: r.message });
          })}>{store.hasIntakeToken ? t("rotateToken") : t("createToken")}</Button>
        </div>
        {secrets.length > 0 ? (
          <Alert>
            <AlertDescription className="space-y-2">
              <p className="font-medium">{t("shownOnce")}</p>
              {secrets.map(([k, v]) => <Secret key={k} label={k} value={v} />)}
            </AlertDescription>
          </Alert>
        ) : null}
        {msg ? <p className={msg.ok ? "text-emerald-700" : "text-destructive"}>{msg.text}</p> : null}
      </CardContent>
    </Card>
  );
}
