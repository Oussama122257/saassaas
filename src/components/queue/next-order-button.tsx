"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { PhoneCall } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { nextOrderAction } from "@/app/[locale]/(app)/queue/actions";
import { formatDateTime } from "@/lib/utils";

export function NextOrderButton({ locale, auto = false }: { locale: string; auto?: boolean }) {
  const t = useTranslations("queue");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  const go = () =>
    start(async () => {
      const r = await nextOrderAction();
      if (!r.ok) {
        setInfo(r.message);
        return;
      }
      if (r.next) {
        router.push(`/queue/${r.next}`);
        return;
      }
      if (r.kind === "blocked") setInfo(t("blocked", { reason: t(`blockReason.${r.reason}` as "blockReason.PRAYER") }));
      else setInfo(r.nextAt ? `${t("empty")} ${t("nextAt", { time: formatDateTime(r.nextAt, locale) })}` : t("empty"));
    });

  useEffect(() => {
    if (auto) go();
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "n" || e.key === "N") && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <Button size="lg" className="h-14 w-full text-lg" onClick={go} disabled={pending} data-testid="next-order">
        <PhoneCall className="size-5" aria-hidden /> {t("start")}
      </Button>
      {info ? (
        <Alert>
          <AlertDescription>{info}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
