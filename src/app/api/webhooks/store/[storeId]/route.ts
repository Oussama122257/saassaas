import { NextResponse, type NextRequest } from "next/server";
import { prisma, withSystemContext } from "@/lib/db";
import { verifyDzbuildSignature } from "@/lib/adapters/stores/dzbuild";
import { safeEqual, sha256Hex } from "@/lib/crypto";
import { finishReceipt, ingestPayload, recordReceipt, storeSettings } from "@/lib/stores/service";
import { readWebhookSecret } from "@/lib/stores/webhookSecrets";

/**
 * Generic "webhook + field mapping" store adapter (section 19c.5): any store builder (YouCan,
 * WooCommerce, Lightfunnels, Ayor, Foorweb, Feeef…) posts its order JSON here; the store's field
 * mapping turns it into an order. Auth: `X-Signature: t=…,v1=…` (HMAC-SHA256 of "t.rawBody" with
 * the store webhook secret) or `X-Webhook-Token` (the store intake token).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const raw = await req.text();
  const store = await withSystemContext("generic-webhook", () => prisma.store.findFirst({ where: { id: storeId, active: true, merchantId: { not: "" } } }));
  if (!store) return NextResponse.json({ error: "unknown_endpoint" }, { status: 404 });
  const secret = readWebhookSecret(store);
  const token = req.headers.get("x-webhook-token");
  const tokenHash = storeSettings(store).intakeToken;
  const signed = secret ? verifyDzbuildSignature(raw, req.headers.get("x-signature"), secret).ok : false;
  const tokenOk = !!token && !!tokenHash && safeEqual(sha256Hex(token), tokenHash);
  if (!signed && !tokenOk) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const receipt = await recordReceipt({ provider: `generic:${store.id}`, storeId: store.id, topic: "generic", deliveryId: req.headers.get("x-delivery-id"), rawBody: raw, verified: true, payload });
  if (receipt.duplicate) return NextResponse.json({ ok: true, duplicate: true });
  try {
    const r = await ingestPayload(store, payload);
    await finishReceipt(receipt.id, "PROCESSED", { orderId: r.order.id });
    return NextResponse.json({ ok: true, order_id: r.order.id, created: r.created }, { status: r.created ? 201 : 200 });
  } catch (err) {
    await finishReceipt(receipt.id, "FAILED", { error: (err as Error).message });
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 422 });
  }
}
