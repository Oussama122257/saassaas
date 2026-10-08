"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { setLocaleAction } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";

/** FR ⇄ AR toggle. Changes the URL prefix (which drives `dir`) and remembers the preference. */
export function LocaleSwitcher({ locale }: { locale: string }) {
  const t = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const next = locale === "ar" ? "fr" : "ar";
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={t("language")}
      data-testid="locale-switcher"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await setLocaleAction(next).catch(() => undefined);
          router.replace(pathname, { locale: next });
          router.refresh();
        })
      }
    >
      {next === "ar" ? t("arabic") : t("french")}
    </Button>
  );
}
