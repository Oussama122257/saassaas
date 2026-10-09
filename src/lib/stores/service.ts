import type { Prisma, Store } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { decryptJson, encryptJson, randomToken, sha256Hex } from "@/lib/crypto";
import { addDays } from "@/lib/time";
import type { FieldMapping, MappedOrder } from "@/lib/ingest/fieldMapping";
import { ingestOrder, type IngestResult } from "@/lib/ingest/pipeline";
import { transitionOrder, TransitionError } from "@/lib/orders/orderTransitions";
import { systemContext } from "@/lib/tenant";
import { ShopifyClient, graphqlOrderToRest, mapShopifyOrder, SHOPIFY_WEBHOOK_TOPICS } from "@/lib/adapters/stores/shopify";
import { DzbuildClient, dzbuildStatusFor, mapDzbuildOrder } from "@/lib/adapters/stores/dzbuild";
import { fetchSheetRows, mapSheetRows } from "@/lib/adapters/stores/googleSheets";
import type { FetchLike } from "@/lib/adapters/stores/http";

/**
 * Store integrations: credentials (encrypted at rest), per-store settings, webhook receipts
 * (idempotency + preview of the last payloads for the field-mapping screen), backfill, polling and
 * status write-back. Shared by Shopify, DZBuild, Google Sheets and the generic webhook adapter.
 */

export interface StoreSettings {
  writeBack?: { tags?: boolean; cancel?: boolean; status?: boolean; note?: boolean; fulfill?: boolean; markPaid?: boolean };
  backfillDays?: number;
  sheet?: { sheetId: string; gid: string; lastRow: number; hasHeader?: boolean };
  dzbuild?: { lastPolledAt?: string };
  intakeToken?: string;
}

export function storeSettings(store: Pick<Store, "settings">): StoreSettings {
  return (store.settings ?? {}) as StoreSettings;
}

export interface ShopifyCredentials {
  shop: string;
  accessToken: string;
  scope?: string;
}
export interface DzbuildCredentials {
  apiKey: string;
}

export function storeCredentials<T>(store: Pick<Store, "credentials">): T | null {
  if (!store.credentials) return null;
  try {
    return decryptJson<T>(store.credentials);
  } catch {
    return null;
  }
}

export async function saveStoreCredentials(storeId: string, merchantId: string, creds: unknown): Promise<void> {
  await prisma.store.update({ where: { id: storeId, merchantId }, data: { credentials: encryptJson(creds), connection: "CONNECTED", lastError: null } });
}

export function shopifyClientFor(store: Pick<Store, "credentials">, fetchImpl?: FetchLike): ShopifyClient | null {
  const c = storeCredentials<ShopifyCredentials>(store);
  return c ? new ShopifyClient(c.shop, c.accessToken, fetchImpl) : null;
}

export function dzbuildClientFor(store: Pick<Store, "credentials">, fetchImpl?: FetchLike): DzbuildClient | null {
  const c = storeCredentials<DzbuildCredentials>(store);
  return c ? new DzbuildClient(c.apiKey, fetchImpl) : null;
}

// ─────────────────────────────── webhook receipts ───────────────────────────────

export async function recordReceipt(params: { provider: string; storeId: string | null; topic: string; deliveryId: string | null; rawBody: string; verified: boolean; payload: unknown }): Promise<{ id: string; duplicate: boolean }> {
  const deliveryId = params.deliveryId || sha256Hex(`${params.topic}:${params.rawBody}`);
  return withSystemContext("webhook-receipt", async () => {
    const existing = await prisma.webhookReceipt.findUnique({ where: { provider_deliveryId: { provider: params.provider, deliveryId } } });
    if (existing && existing.status === "PROCESSED") return { id: existing.id, duplicate: true };
    if (existing) return { id: existing.id, duplicate: false };
    try {
      const r = await prisma.webhookReceipt.create({
        data: { provider: params.provider, storeId: params.storeId, topic: params.topic, deliveryId, verified: params.verified, payload: (params.payload ?? {}) as Prisma.InputJsonValue },
      });
      return { id: r.id, duplicate: false };
    } catch {
      const again = await prisma.webhookReceipt.findUnique({ where: { provider_deliveryId: { provider: params.provider, deliveryId } } });
      return { id: again?.id ?? "", duplicate: true };
    }
  });
}

export async function finishReceipt(id: string, status: "PROCESSED" | "IGNORED" | "FAILED" | "REJECTED", extra: { orderId?: string; error?: string } = {}): Promise<void> {
  if (!id) return;
  await withSystemContext("webhook-receipt", () => prisma.webhookReceipt.update({ where: { id }, data: { status, orderId: extra.orderId, error: extra.error?.slice(0, 500) } }));
}

/** Last N webhook payloads of a store (field-mapping preview). */
export async function recentPayloads(storeId: string, merchantIds: string[], take = 5): Promise<Array<{ id: string; topic: string; receivedAt: Date; payload: unknown }>> {
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId: { in: merchantIds } }, select: { id: true } });
  if (!store) return [];
  return prisma.webhookReceipt.findMany({
    where: { storeId, topic: { in: ["orders/create", "order.created", "order", "generic"] } },
    orderBy: { receivedAt: "desc" },
    take,
    select: { id: true, topic: true, receivedAt: true, payload: true },
  });
}

// ─────────────────────────────── ingestion per channel ───────────────────────────────

export function mapForStore(store: Pick<Store, "channel" | "fieldMapping">, payload: unknown): MappedOrder {
  const overrides = (store.fieldMapping ?? null) as FieldMapping | null;
  switch (store.channel) {
    case "SHOPIFY":
      return mapShopifyOrder(payload, overrides);
    case "DZBUILD":
      return mapDzbuildOrder(payload, overrides);
    default:
      return mapDzbuildOrder(payload, overrides); // generic webhook + field mapping (unwraps {data:{…}})
  }
}

/** Shopify orders/cancelled: cancel in our platform if not yet shipped. */
export async function cancelFromSource(storeId: string, externalId: string): Promise<boolean> {
  return withSystemContext("source-cancel", async () => {
    const order = await prisma.order.findFirst({ where: { storeId, externalId, merchantId: { not: "" } } });
    if (!order) return false;
    if (order.statusGroup !== "CONFIRMATION" && order.status !== "PRET_A_EXPEDIER" && order.status !== "EN_PREPARATION") return false;
    try {
      await transitionOrder(systemContext("source-cancel"), { orderId: order.id, to: "ANNULEE", payload: { cancelReason: "CANCELLED_BY_CUSTOMER", source: "store" } });
      return true;
    } catch (err) {
      if (err instanceof TransitionError) {
        await prisma.order.update({ where: { id: order.id, merchantId: order.merchantId }, data: { flags: { push: "CANCELLED_IN_SOURCE" } } });
        await prisma.orderEvent.create({ data: { orderId: order.id, type: "NOTE", payload: { note: "Order cancelled in the source store", sourceCancel: true } } });
      }
      return false;
    }
  });
}

/** Address / item edits made in Shopify before shipping (orders/updated). */
export async function updateFromSource(storeId: string, mapped: MappedOrder): Promise<boolean> {
  if (!mapped.externalId) return false;
  return withSystemContext("source-update", async () => {
    const order = await prisma.order.findFirst({ where: { storeId, externalId: mapped.externalId, merchantId: { not: "" } } });
    if (!order || order.statusGroup !== "CONFIRMATION") return false;
    const changes: Record<string, unknown> = {};
    if (mapped.address && mapped.address !== order.address) changes.address = mapped.address;
    if (mapped.commune && mapped.commune !== order.commune) changes.commune = mapped.commune;
    if (mapped.customerName && mapped.customerName !== order.customerName) changes.customerName = mapped.customerName;
    if (Object.keys(changes).length === 0) return false;
    await prisma.order.update({ where: { id: order.id, merchantId: order.merchantId }, data: changes });
    await prisma.orderEvent.create({ data: { orderId: order.id, type: "FIELD_EDIT", payload: { source: "store", changes } as Prisma.InputJsonValue } });
    return true;
  });
}

export async function ingestPayload(store: Store, payload: unknown, meta: { publicIntake?: boolean; clientIp?: string | null } = {}): Promise<IngestResult> {
  return ingestOrder(store, mapForStore(store, payload), meta);
}

// ─────────────────────────────── Shopify connect + backfill ───────────────────────────────

export async function shopifyBackfill(store: Store, opts: { days?: number; fetchImpl?: FetchLike } = {}): Promise<{ products: number; orders: number; created: number }> {
  const client = shopifyClientFor(store, opts.fetchImpl);
  if (!client) throw new Error("Store has no Shopify credentials");
  let products = 0;
  await withSystemContext("shopify-backfill", async () => {
    for await (const p of client.products()) {
      const firstPrice = Math.round(Number(p.variants[0]?.price ?? 0));
      const sku = p.variants.length === 1 ? p.variants[0]?.sku ?? null : null;
      const existingMap = await prisma.skuMapping.findUnique({ where: { merchantId_externalSku: { merchantId: store.merchantId, externalSku: `shopify:${p.id}` } } });
      let productId = existingMap?.productId;
      if (!productId) {
        const created = await prisma.product.create({ data: { merchantId: store.merchantId, name: p.title, sku, price: firstPrice } });
        productId = created.id;
        await prisma.skuMapping.create({ data: { merchantId: store.merchantId, storeId: store.id, externalSku: `shopify:${p.id}`, productId } });
      }
      for (const v of p.variants) {
        if (p.variants.length > 1 && v.title !== "Default Title") {
          const variant = await prisma.productVariant.create({ data: { productId, name: v.title, sku: v.sku, price: Math.round(Number(v.price)) } });
          if (v.sku) await prisma.skuMapping.upsert({ where: { merchantId_externalSku: { merchantId: store.merchantId, externalSku: v.sku } }, create: { merchantId: store.merchantId, storeId: store.id, externalSku: v.sku, productId, variantId: variant.id }, update: {} });
        } else if (v.sku) {
          await prisma.skuMapping.upsert({ where: { merchantId_externalSku: { merchantId: store.merchantId, externalSku: v.sku } }, create: { merchantId: store.merchantId, storeId: store.id, externalSku: v.sku, productId }, update: {} });
        }
      }
      // also map by title so line items without SKU resolve
      await prisma.skuMapping.upsert({ where: { merchantId_externalSku: { merchantId: store.merchantId, externalSku: p.title.slice(0, 190) } }, create: { merchantId: store.merchantId, storeId: store.id, externalSku: p.title.slice(0, 190), productId }, update: {} });
      products++;
    }
  });
  let orders = 0;
  let created = 0;
  const since = addDays(new Date(), -(opts.days ?? storeSettings(store).backfillDays ?? 7));
  for await (const node of client.openOrdersSince(since)) {
    orders++;
    const r = await ingestOrder(store, mapShopifyOrder(graphqlOrderToRest(node), store.fieldMapping as FieldMapping | null), { source: "shopify_backfill" });
    if (r.created) created++;
  }
  await withSystemContext("shopify-backfill", () => prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { lastSyncAt: new Date() } }));
  return { products, orders, created };
}

export async function shopifySubscribeWebhooks(store: Store, appUrl: string, fetchImpl?: FetchLike): Promise<number> {
  const client = shopifyClientFor(store, fetchImpl);
  if (!client) return 0;
  let n = 0;
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (topic.startsWith("customers/") || topic === "shop/redact") continue; // set in the app config (public apps)
    await client.subscribeWebhook(topic, `${appUrl.replace(/\/$/, "")}/api/webhooks/shopify`);
    n++;
  }
  return n;
}

// ─────────────────────────────── polling ───────────────────────────────

/** DZBuild safety net: GET /v1/orders?since= every 10 minutes in case a webhook was missed. */
export async function pollDzbuild(store: Store, fetchImpl?: FetchLike): Promise<{ seen: number; created: number }> {
  const client = dzbuildClientFor(store, fetchImpl);
  if (!client) return { seen: 0, created: 0 };
  const settings = storeSettings(store);
  const since = settings.dzbuild?.lastPolledAt ? new Date(new Date(settings.dzbuild.lastPolledAt).getTime() - 10 * 60_000) : addDays(new Date(), -2);
  const startedAt = new Date();
  let cursor: string | undefined;
  let seen = 0;
  let created = 0;
  for (let page = 0; page < 20; page++) {
    const r = await client.listOrders({ since, cursor, limit: 100, status: "pending" });
    for (const raw of r.items) {
      seen++;
      const res = await ingestOrder(store, mapDzbuildOrder(raw, store.fieldMapping as FieldMapping | null), { source: "dzbuild_poll" });
      if (res.created) created++;
    }
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  await withSystemContext("dzbuild-poll", () =>
    prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { lastSyncAt: startedAt, settings: { ...settings, dzbuild: { ...settings.dzbuild, lastPolledAt: startedAt.toISOString() } } as Prisma.InputJsonValue } }),
  );
  return { seen, created };
}

/** Google Sheets: read rows after the last processed row and ingest them. */
export async function pollSheet(store: Store, fetchImpl?: FetchLike): Promise<{ rows: number; created: number }> {
  const settings = storeSettings(store);
  if (!settings.sheet?.sheetId) return { rows: 0, created: 0 };
  const rows = await fetchSheetRows(settings.sheet.sheetId, settings.sheet.gid ?? "0", fetchImpl);
  const mapped = mapSheetRows(rows, store.fieldMapping as FieldMapping | null, settings.sheet.lastRow ?? 1, settings.sheet.hasHeader !== false);
  let created = 0;
  let lastRow = settings.sheet.lastRow ?? 1;
  for (const r of mapped) {
    try {
      const res = await ingestOrder(store, r.mapped, { source: "google_sheet" });
      if (res.created) created++;
    } catch (err) {
      console.error(`[sheets] row ${r.rowNumber} of store ${store.id}: ${(err as Error).message}`);
    }
    lastRow = r.rowNumber;
  }
  await withSystemContext("sheet-poll", () =>
    prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { lastSyncAt: new Date(), settings: { ...settings, sheet: { ...settings.sheet!, lastRow } } as Prisma.InputJsonValue } }),
  );
  return { rows: mapped.length, created };
}

// ─────────────────────────────── write-back ───────────────────────────────

/**
 * Platform → store write-back (sections 12.5 and 12.7). Each action is a per-store toggle.
 * Called by the worker for WRITE_BACK side effects.
 */
export async function writeBackStatus(orderId: string, status: string, fetchImpl?: FetchLike): Promise<string> {
  return withSystemContext("write-back", async () => {
    const order = await prisma.order.findFirst({ where: { id: orderId }, include: { store: true, courier: true } });
    if (!order?.externalId) return "no-external-id";
    const store = order.store;
    const wb = { tags: true, cancel: false, status: true, fulfill: true, markPaid: false, ...(storeSettings(store).writeBack ?? {}) };
    if (store.channel === "SHOPIFY") {
      const client = shopifyClientFor(store, fetchImpl);
      if (!client) return "no-credentials";
      const gid = order.externalId.startsWith("gid://") ? order.externalId : `gid://shopify/Order/${order.externalId}`;
      if (wb.tags) await client.setStatusTag(gid, status);
      if (wb.cancel && ["ANNULEE", "FAUSSE_COMMANDE", "DOUBLE"].includes(status)) await client.cancel(gid);
      if (wb.fulfill && status === "EXPEDIE" && order.trackingNumber) await client.fulfill(gid, { company: order.courier?.name ?? "Courier", number: order.trackingNumber });
      if (wb.markPaid && (status === "LIVRE" || status === "ENCAISSE")) await client.markAsPaid(gid);
      return "shopify";
    }
    if (store.channel === "DZBUILD") {
      if (!wb.status) return "disabled";
      const client = dzbuildClientFor(store, fetchImpl);
      if (!client) return "no-credentials";
      const target = dzbuildStatusFor(status);
      if (!target) return "nothing";
      if (target === "cancel") {
        if (wb.cancel) await client.cancel(order.externalId);
        return "dzbuild-cancel";
      }
      await client.setStatus(order.externalId, target, target === "shipped" && order.trackingNumber ? { tracking_number: order.trackingNumber } : {});
      return `dzbuild-${target}`;
    }
    return "unsupported-channel";
  });
}

/** Public intake token for landing forms (shown once in the store settings). */
export async function rotateIntakeToken(storeId: string, merchantId: string): Promise<string> {
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId } });
  if (!store) throw new Error("Store not found");
  const token = randomToken(18);
  await prisma.store.update({ where: { id: storeId, merchantId }, data: { settings: { ...storeSettings(store), intakeToken: sha256Hex(token) } as Prisma.InputJsonValue } });
  return token;
}
