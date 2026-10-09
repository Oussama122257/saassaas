import { NextResponse, type NextRequest } from "next/server";
import { prisma, withSystemContext } from "@/lib/db";
import { verifyDzbuildSignature } from "@/lib/adapters/stores/dzbuild";
import { cancelFromSource, finishReceipt, ingestPayload, recordReceipt } from "@/lib/stores/service";
import { readWebhookSecret } from "@/lib/stores/webhookSecrets";
import { mapDzbuildOrder } from "@/lib/adapters/stores/dzbuild";
import type { FieldMapping } from "@/lib/ingest/fieldMapping";

/**
 * DZBuild webhooks (section 12.7): X-DZ-Signature "t=…,v1=…" = HMAC-SHA256(secret, "t.rawBody"),
 * rejected when older than 5 minutes. DZBuild retries 5 times and disables an endpoint after 10
 * failures, so business rejections answer 200.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  const store = await withSystemContext("dzbuild-webhook", () => prisma.store.findFirst({ where: { id: storeId, channel: "DZBUILD", merchantId: { not: "" } } }));
  const secret = store ? readWebhookSecret(store) : null;
  if (!store || !secret) return NextResponse.json({ error: "unknown_endpoint" }, { status: 404 });
  const check = verifyDzbuildSignature(raw, req.headers.get("x-dz-signature"), secret);
  if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 401 });

  let payload: { event?: string; type?: string; id?: string } & Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const event = String(payload.event ?? payload.type ?? req.headers.get("x-dz-event") ?? "order.created");
  if (event === "webhook.verify" || event === "webhook.test") return NextResponse.json({ ok: true });

  const receipt = await recordReceipt({ provider: "dzbuild", storeId: store.id, topic: event, deliveryId: req.headers.get("x-dz-delivery") ?? (payload.id ? `${event}:${payload.id}` : null), rawBody: raw, verified: true, payload });
  if (receipt.duplicate) return NextResponse.json({ ok: true, duplicate: true });
  try {
    if (event === "order.created") {
      const r = await ingestPayload(store, payload);
      await finishReceipt(receipt.id, "PROCESSED", { orderId: r.order.id });
      return NextResponse.json({ ok: true, orderId: r.order.id, created: r.created });
    }
    if (event === "order.cancelled") {
      const mapped = mapDzbuildOrder(payload, store.fieldMapping as FieldMapping | null);
      const done = mapped.externalId ? await cancelFromSource(store.id, mapped.externalId) : false;
      await finishReceipt(receipt.id, done ? "PROCESSED" : "IGNORED");
      return NextResponse.json({ ok: true, cancelled: done });
    }
    // our own write-backs echo back as order.confirmed/shipped/…: nothing to do
    await finishReceipt(receipt.id, "IGNORED");
    return NextResponse.json({ ok: true, ignored: event });
  } catch (err) {
    await finishReceipt(receipt.id, "FAILED", { error: (err as Error).message });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 200 });
  }
}
