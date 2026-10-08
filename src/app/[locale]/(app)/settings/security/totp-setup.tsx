"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confirmTotpEnrollmentAction, disableTotpAction, startTotpEnrollmentAction } from "./actions";

export function TotpSetup({ enabled }: { enabled: boolean }) {
  const t = useTranslations("settings.security");
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submitCode = (fn: (code: string) => Promise<{ ok: boolean; message?: string }>) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    start(async () => {
      const res = await fn(code);
      if (res.ok) {
        setSetup(null);
        setError(null);
        router.refresh();
      } else setError(res.message === "invalid" ? t("invalidCode") : (res.message ?? t("invalidCode")));
    });
  };

  return (
    <Card className="max-w-xl">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{enabled ? t("enabled") : t("disabled")}</CardTitle>
        <Badge variant={enabled ? "default" : "secondary"} data-testid="totp-status">{enabled ? "ON" : "OFF"}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {enabled ? (
          <form onSubmit={submitCode(disableTotpAction)} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="code">{t("code")}</Label>
              <Input id="code" name="code" inputMode="numeric" maxLength={7} required dir="ltr" className="max-w-40" />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" variant="destructive" disabled={pending}>{t("disable")}</Button>
          </form>
        ) : setup ? (
          <form onSubmit={submitCode(confirmTotpEnrollmentAction)} className="space-y-3">
            <p className="text-sm">{t("setupStep1")}</p>
            <code className="block break-all rounded bg-muted px-3 py-2 font-mono text-lg tracking-widest" dir="ltr" data-testid="totp-secret">{setup.secret}</code>
            <p className="text-xs text-muted-foreground">{t("otpauth")}: <span className="break-all font-mono" dir="ltr">{setup.otpauth}</span></p>
            <p className="text-sm">{t("setupStep2")}</p>
            <div className="space-y-1.5">
              <Label htmlFor="code">{t("code")}</Label>
              <Input id="code" name="code" inputMode="numeric" maxLength={7} required dir="ltr" className="max-w-40" autoFocus />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={pending}>{t("verify")}</Button>
          </form>
        ) : (
          <Button
            disabled={pending}
            data-testid="enable-totp"
            onClick={() =>
              start(async () => {
                const res = await startTotpEnrollmentAction();
                if (res.ok) setSetup({ secret: res.secret, otpauth: res.otpauth });
                else setError(res.message);
              })
            }
          >
            {t("enable")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
