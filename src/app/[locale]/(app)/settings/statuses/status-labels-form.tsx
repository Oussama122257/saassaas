"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { usePathname } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { saveStatusLabelsAction } from "./actions";

interface Row {
  code: string;
  defaultFr: string;
  defaultAr: string;
  labelFr: string;
  labelAr: string;
}

export function StatusLabelsForm({ merchants, merchantId, rows }: { merchants: Array<{ id: string; name: string }>; merchantId: string; rows: Row[] }) {
  const t = useTranslations("settings.statuses");
  const to = useTranslations("orders");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const labels = rows.map((r) => ({ code: r.code, labelFr: String(fd.get(`fr:${r.code}`) ?? ""), labelAr: String(fd.get(`ar:${r.code}`) ?? "") }));
        start(async () => {
          const res = await saveStatusLabelsAction({ merchantId, labels });
          setMessage(res.ok ? t("saved") : (res.message ?? tc("error")));
          router.refresh();
        });
      }}
    >
      {merchants.length > 1 ? (
        <select
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={merchantId}
          onChange={(e) => {
            const next = new URLSearchParams(params.toString());
            next.set("merchant", e.target.value);
            router.push(`${pathname}?${next.toString()}`);
          }}
          aria-label={to("merchant")}
        >
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-start">{t("code")}</TableHead>
              <TableHead className="text-start">{t("defaultFr")}</TableHead>
              <TableHead className="text-start">{t("customFr")}</TableHead>
              <TableHead className="text-start">{t("defaultAr")}</TableHead>
              <TableHead className="text-start">{t("customAr")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="font-mono text-xs">{r.code}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.defaultFr}</TableCell>
                <TableCell><Input name={`fr:${r.code}`} defaultValue={r.labelFr} className="h-8 min-w-40" maxLength={60} /></TableCell>
                <TableCell className="text-sm text-muted-foreground" dir="rtl">{r.defaultAr}</TableCell>
                <TableCell><Input name={`ar:${r.code}`} defaultValue={r.labelAr} className="h-8 min-w-40" dir="rtl" maxLength={60} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>{tc("save")}</Button>
        {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
      </div>
    </form>
  );
}
