"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { loginAction, type LoginState } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const needsTotp = state.error === "totp_required" || state.error === "totp_invalid";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4" data-testid="login-form">
          <input type="hidden" name="locale" value={locale} />
          <div className="space-y-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={state.email ?? ""} dir="ltr" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required dir="ltr" />
          </div>
          {needsTotp ? (
            <div className="space-y-2">
              <Label htmlFor="totp">{t("totp")}</Label>
              <Input id="totp" name="totp" inputMode="numeric" pattern="[0-9 ]*" autoComplete="one-time-code" maxLength={7} dir="ltr" autoFocus />
              <p className="text-xs text-muted-foreground">{t("totpHint")}</p>
            </div>
          ) : null}
          {state.error ? (
            <Alert variant="destructive" data-testid="login-error">
              <AlertDescription>{t(`errors.${state.error}`)}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("signingIn") : t("signIn")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
