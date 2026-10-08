"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { assignAction } from "@/app/[locale]/(app)/orders/actions";

export function AssignDialog({ locale, orderId, agents, currentId }: { locale: string; orderId: string; agents: Array<{ id: string; name: string }>; currentId: string | null }) {
  const t = useTranslations("transition");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(agents.find((a) => a.id !== currentId)?.id ?? agents[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (agents.length === 0) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="assign-order">{currentId ? t("reassign") : t("assign")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{currentId ? t("reassign") : t("assign")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="assign-agent">{t("assignTo")}</Label>
          <select id="assign-agent" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={target} onChange={(e) => setTarget(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={a.id === currentId}>{a.name}</option>
            ))}
          </select>
        </div>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>{tc("cancel")}</Button>
          <Button
            disabled={pending || !target}
            onClick={() =>
              start(async () => {
                const res = await assignAction({ locale, orderId, toUserId: target });
                if (res.ok) {
                  setOpen(false);
                  router.refresh();
                } else setError(res.message);
              })
            }
          >
            {t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
