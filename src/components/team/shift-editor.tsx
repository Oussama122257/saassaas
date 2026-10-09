"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { saveShiftsAction } from "@/app/[locale]/(app)/team/actions";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function ShiftEditor({ userId, days, startMin, endMin }: { userId: string; days: number[]; startMin: number; endMin: number }) {
  const t = useTranslations("team");
  const [sel, setSel] = useState(days);
  const [start, setStart] = useState(hhmm(startMin));
  const [end, setEnd] = useState(hhmm(endMin));
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, run] = useTransition();
  return (
    <div className="flex min-w-80 flex-wrap items-center gap-1">
      {[6, 0, 1, 2, 3, 4, 5].map((d) => (
        <button key={d} type="button" onClick={() => setSel((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]))} className={cn("rounded border px-1.5 text-[11px]", sel.includes(d) ? "border-primary bg-primary text-primary-foreground" : "")} aria-pressed={sel.includes(d)}>
          {t(`weekday.${d}` as "weekday.0")}
        </button>
      ))}
      <Input type="time" className="h-7 w-24 text-xs" value={start} onChange={(e) => setStart(e.target.value)} />
      <Input type="time" className="h-7 w-24 text-xs" value={end} onChange={(e) => setEnd(e.target.value)} />
      <Button size="sm" variant="outline" className="h-7" disabled={pending} onClick={() => run(async () => { const r = await saveShiftsAction({ userId, days: sel, startMin: toMin(start), endMin: toMin(end) }); setMsg(r.ok ? "✓" : r.message ?? "error"); })}>{t("save")}</Button>
      {msg ? <span className="text-xs text-muted-foreground">{msg}</span> : null}
    </div>
  );
}
