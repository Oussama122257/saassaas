import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { verifyShopifyWebhook, mapShopifyOrder } from "@/lib/adapters/stores/shopify";
import { cancelFromSource, finishReceipt, ingestPayload, recordReceipt, updateFromSource } from "@/lib/stores/service";
import { readWebhookSecret } from "@/lib/stores/webhookSecrets";
import type { FieldMapping } from "@/lib/ingest/fieldMapping";

/**
 * Shopify webhooks (section 12.5). Every request is HMAC-verified before processing; ingestion is
 * idempotent on X-Shopify-Webhook-Id and on (storeId, externalId) because webhooks can arrive
 * twice or out of order.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shop = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  const webhookId = req.headers.get("x-shopify-webhook-id");
  const hmac = req.headers.get("x-shopify-hmac-sha256");

  const store = await withSystemContext("shopify-webhook", () => prisma.store.findFirst({ where: { channel: "SHOPIFY", externalRef: shop, merchantId: { not: "" } } }));
  const secret = (store ? readWebhookSecret(store) : null) ?? process.env.SHOPIFY_API_SECRET ?? "";
  if (!store || !verifyShopifyWebhook(raw, hmac, secret)) {
    return NextResponse.json({ error: "invalid_hmac" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const receipt = await recordReceipt({ provider: "shopify", storeId: store.id, topic, deliveryId: webhookId, rawBody: raw, verified: true, payload });
  if (receipt.duplicate) return NextResponse.json({ ok: true, duplicate: true });

  try {
    switch (topic) {
      case "orders/create": {
        const r = await ingestPayload(store, payload);
        await finishReceipt(receipt.id, "PROCESSED", { orderId: r.order.id });
        return NextResponse.json({ ok: true, orderId: r.order.id, created: r.created });
      }
      case "orders/updated": {
        const mapped = mapShopifyOrder(payload, store.fieldMapping as FieldMapping | null);
        const changed = await updateFromSource(store.id, mapped);
        await finishReceipt(receipt.id, changed ? "PROCESSED" : "IGNORED");
        return NextResponse.json({ ok: true, changed });
      }
      case "orders/cancelled": {
        const p = payload as { admin_graphql_api_id?: string; id?: number | string };
        const cancelled = await cancelFromSource(store.id, String(p.admin_graphql_api_id ?? p.id));
        await finishReceipt(receipt.id, cancelled ? "PROCESSED" : "IGNORED");
        return NextResponse.json({ ok: true, cancelled });
      }
      case "app/uninstalled":
      case "shop/redact":
        await withSystemContext("shopify-uninstall", () =>
          prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { connection: "DISCONNECTED", ...(topic === "shop/redact" ? { credentials: null } : {}) } }),
        );
        await finishReceipt(receipt.id, "PROCESSED");
        return NextResponse.json({ ok: true });
      case "customers/redact": {
        // mandatory privacy webhook: anonymize the listed orders of this store
        const p = payload as { orders_to_redact?: Array<number | string> };
        const ids = (p.orders_to_redact ?? []).flatMap((id) => [String(id), `gid://shopify/Order/${id}`]);
        await withSystemContext("shopify-redact", () =>
          prisma.order.updateMany({
            where: { storeId: store.id, merchantId: store.merchantId, externalId: { in: ids } },
            data: { customerName: "REDACTED", address: null, address2: null, landmark: null, customerPhone2: null } satisfies Prisma.OrderUpdateManyMutationInput,
          }),
        );
        await finishReceipt(receipt.id, "PROCESSED");
        return NextResponse.json({ ok: true });
      }
      default:
        // products/*, customers/data_request: acknowledged; products are refreshed by the backfill / sync job
        await finishReceipt(receipt.id, "IGNORED");
        return NextResponse.json({ ok: true, ignored: topic });
    }
  } catch (err) {
    await finishReceipt(receipt.id, "FAILED", { error: (err as Error).message });
    console.error("[shopify webhook]", err);
    // 200 for business rejections so Shopify does not retry forever; 500 only for unexpected failures
    const known = ["INTAKE_INVALID", "INTAKE_REFUSED", "INVALID_ORDER"].includes((err as { code?: string }).code ?? "");
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: known ? 200 : 500 });
  }
}
