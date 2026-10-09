"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { setAvailabilityAction } from "@/app/[locale]/(app)/queue/actions";

const STATES = ["AVAILABLE", "BREAK", "OFFLINE"] as const;
const DOT: Record<(typeof STATES)[number], string> = { AVAILABLE: "bg-emerald-500", BREAK: "bg-amber-500", OFFLINE: "bg-zinc-400" };

/** Live availability (section 9.1). Going offline during a shift releases open orders to the pool. */
export function AvailabilityToggle({ value }: { value: (typeof STATES)[number] }) {
  const t = useTranslations("availability");
  const router = useRouter();
  const [current, setCurrent] = useState(value);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-1" data-testid="availability">
      <div className="text-xs text-muted-foreground">{t("label")}</div>
      <div className="flex gap-1">
        {STATES.map((s) => (
          <button key={s} type="button" disabled={pending} aria-pressed={current === s} onClick={() => start(async () => {
            const r = await setAvailabilityAction({ availability: s });
            if (r.ok) {
              setCurrent(s);
              setNote(s === "OFFLINE" && r.message && r.message !== "0" ? t("released", { count: Number(r.message) }) : null);
              router.refresh();
            }
          })} className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]", current === s ? "border-primary bg-accent" : "opacity-70")}>
            <span className={cn("size-2 rounded-full", DOT[s])} aria-hidden /> {t(s)}
          </button>
        ))}
      </div>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
