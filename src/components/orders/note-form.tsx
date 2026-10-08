"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { noteAction } from "@/app/[locale]/(app)/orders/actions";

export function NoteForm({ locale, orderId }: { locale: string; orderId: string }) {
  const t = useTranslations("order");
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      ref={ref}
      className="flex flex-col gap-2 sm:flex-row sm:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
        if (!note) return;
        start(async () => {
          const res = await noteAction({ locale, orderId, note });
          if (res.ok) {
            ref.current?.reset();
            setError(null);
            router.refresh();
          } else setError(res.message);
        });
      }}
    >
      <Textarea name="note" rows={2} placeholder={t("notePlaceholder")} className="flex-1" />
      <Button type="submit" variant="secondary" disabled={pending}>{t("addNote")}</Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
