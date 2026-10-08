import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentContext, getSessionUser } from "@/lib/auth/session";
import { logoutAction } from "@/lib/auth/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { LoginForm } from "./login-form";

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await getCurrentContext();
  if (ctx) redirect(`/${locale}/dashboard`);
  const sessionUser = await getSessionUser();
  const t = await getTranslations("auth");
  const tc = await getTranslations("common");
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{tc("appName")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <LocaleSwitcher locale={locale} />
        </div>
        {sessionUser ? (
          <Alert variant="destructive" data-testid="no-membership">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("noMembership")}</span>
              <form action={logoutAction}>
                <input type="hidden" name="locale" value={locale} />
                <button type="submit" className="underline">{tc("signOut")}</button>
              </form>
            </AlertDescription>
          </Alert>
        ) : null}
        <LoginForm locale={locale} />
        <p className="text-xs text-muted-foreground" data-testid="demo-hint">
          {t("demoHint")}
        </p>
      </div>
    </main>
  );
}
