"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { pairDeviceAction, revokeDeviceAction } from "@/app/[locale]/(app)/devices/actions";

export function DevicePairing({ devices }: { devices: Array<{ id: string; name: string; user: string; lastSeen: string }> }) {
  const t = useTranslations("devices");
  const router = useRouter();
  const [name, setName] = useState("");
  const [config, setConfig] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardContent className="space-y-3 pt-6 text-sm">
        <ul className="space-y-1">
          {devices.length === 0 ? <li className="text-muted-foreground">{t("none")}</li> : null}
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2">
              <span>{d.name} · <span className="text-muted-foreground">{d.user} · {t("lastSeen")} {d.lastSeen}</span></span>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { await revokeDeviceAction({ id: d.id }); router.refresh(); })}>{t("revoke")}</Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Input placeholder={t("namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
          <Button disabled={pending} onClick={() => start(async () => { const r = await pairDeviceAction({ name: name || "Android" }); if (r.ok) { setConfig(r.config); router.refresh(); } })}>{t("pair")}</Button>
        </div>
        {config ? (
          <Alert>
            <AlertDescription className="space-y-1">
              <p className="font-medium">{t("shownOnce")}</p>
              <code className="block break-all rounded bg-muted p-2 text-xs" dir="ltr" data-testid="device-config">{config}</code>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
