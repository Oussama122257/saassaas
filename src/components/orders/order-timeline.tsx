import { getTranslations } from "next-intl/server";
import type { OrderDetail } from "@/lib/orders/repository";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/utils";

export async function OrderTimeline({ events, locale, timezone }: { events: OrderDetail["events"]; locale: string; timezone: string }) {
  const t = await getTranslations("order");
  const tc = await getTranslations("common");
  return (
    <ol className="relative space-y-4 border-s ps-5" data-testid="timeline">
      {events.map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        return (
          <li key={e.id} className="relative">
            <span className={`absolute -start-[1.45rem] top-1.5 size-3 rounded-full border-2 border-background ${e.type === "OVERRIDE" ? "bg-rose-500" : "bg-primary"}`} aria-hidden />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{t.has(`events.${e.type}` as never) ? t(`events.${e.type}` as never) : e.type}</span>
              {e.fromStatus ? <StatusBadge status={e.fromStatus} locale={locale} className="text-[11px]" /> : null}
              {e.toStatus ? (
                <>
                  <span className="text-muted-foreground">→</span>
                  <StatusBadge status={e.toStatus} locale={locale} className="text-[11px]" />
                </>
              ) : null}
              <span className="text-xs text-muted-foreground">{formatDateTime(e.createdAt, locale, timezone)}</span>
              <span className="text-xs text-muted-foreground">· {e.actor?.name ?? tc("system")}</span>
            </div>
            <PayloadSummary payload={p} />
          </li>
        );
      })}
    </ol>
  );
}

function PayloadSummary({ payload }: { payload: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof payload.reason === "string") parts.push(payload.reason);
  if (typeof payload.note === "string") parts.push(payload.note);
  if (typeof payload.comment === "string") parts.push(payload.comment);
  if (typeof payload.reasonNote === "string") parts.push(payload.reasonNote);
  if (typeof payload.cancelReason === "string") parts.push(String(payload.cancelReason));
  if (typeof payload.returnReason === "string") parts.push(String(payload.returnReason));
  if (typeof payload.trackingNumber === "string") parts.push(`#${payload.trackingNumber}`);
  if (typeof payload.rule === "string") parts.push(`rule: ${payload.rule}`);
  if (typeof payload.ruleId === "string" && payload.ruleId !== "CREATE") parts.push(String(payload.ruleId));
  if (payload.flagged === true) parts.push("⚠ flagged");
  const call = payload.call as { outcome?: string; proof?: string; durationSec?: number } | undefined;
  if (call?.outcome) parts.push(`${call.outcome}${call.durationSec ? ` · ${call.durationSec}s` : ""}${call.proof ? ` · ${call.proof}` : ""}`);
  if (parts.length === 0) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}
