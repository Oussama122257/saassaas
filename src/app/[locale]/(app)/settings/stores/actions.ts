"use server";

import type { Channel, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma, withSystemContext } from "@/lib/db";
import { encryptJson } from "@/lib/crypto";
import { writeAuditLog } from "@/lib/audit";
import { hasRole } from "@/lib/tenant";
import { requireStoreAdmin } from "@/lib/stores/access";
import { mapForStore, pollDzbuild, pollSheet, recentPayloads, rotateIntakeToken, storeCredentials, storeSettings, type StoreSettings } from "@/lib/stores/service";
import { newWebhookSecret } from "@/lib/stores/webhookSecrets";
import { DzbuildClient } from "@/lib/adapters/stores/dzbuild";
import { fetchSheetRows, mapSheetRows, parseSheetRef } from "@/lib/adapters/stores/googleSheets";
import { isValidShopDomain } from "@/lib/adapters/stores/shopify";
import { MAPPABLE_FIELDS, type FieldMapping, type MappedOrder } from "@/lib/ingest/fieldMapping";
import { validateAddress } from "@/lib/intake/validate";
import { normalizePhone } from "@/lib/phone";
import { enqueue } from "@/lib/queue";

type Result<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; message: string };

async function ctxOrFail() {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) throw new Error("Forbidden");
  return ctx;
}

async function guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

const CHANNELS: Channel[] = ["SHOPIFY", "WOOCOMMERCE", "YOUCAN", "DZBUILD", "GOOGLE_SHEET", "MANUAL", "API"];

export async function createStoreAction(input: { merchantId: string; name: string; channel: string }): Promise<Result<{ id: string }>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    if (!ctx.accessibleMerchantIds.includes(input.merchantId)) return { ok: false, message: "No access to this merchant" };
    if (!CHANNELS.includes(input.channel as Channel)) return { ok: false, message: "Unknown channel" };
    const name = input.name.trim().slice(0, 120);
    if (!name) return { ok: false, message: "Name required" };
    const store = await prisma.store.create({ data: { merchantId: input.merchantId, name, channel: input.channel as Channel, connection: ["MANUAL", "API"].includes(input.channel) ? "CONNECTED" : "DISCONNECTED" } });
    await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { created: true, channel: input.channel } });
    revalidatePath(`/${ctx.locale}/settings/stores`);
    return { ok: true, data: { id: store.id } };
  });
}

/** Shopify custom app (one per store, v1): save its client id / secret, then start the OAuth install. */
export async function saveShopifyAppAction(input: { storeId: string; shop: string; apiKey: string; apiSecret: string }): Promise<Result<{ installUrl: string }>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const shop = input.shop.trim().toLowerCase();
    if (!isValidShopDomain(shop)) return { ok: false, message: "Use the *.myshopify.com domain" };
    const prev = storeCredentials<Record<string, unknown>>(store) ?? {};
    await prisma.store.update({
      where: { id: store.id, merchantId: store.merchantId },
      data: { externalRef: shop, credentials: encryptJson({ ...prev, apiKey: input.apiKey.trim() || prev.apiKey, apiSecret: input.apiSecret.trim() || prev.apiSecret }) },
    });
    await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { shopifyApp: shop } });
    return { ok: true, data: { installUrl: `/api/integrations/shopify/install?storeId=${store.id}&shop=${encodeURIComponent(shop)}` } };
  });
}

/** DZBuild: test the key with GET /v1/whoami, store it encrypted and mint the webhook secret (shown once). */
export async function connectDzbuildAction(input: { storeId: string; apiKey: string }): Promise<Result<{ scopes: string[]; webhookUrl: string; webhookSecret: string }>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const key = input.apiKey.trim();
    if (!/^[^.\s]+\.[^.\s]+$/.test(key)) return { ok: false, message: "Expected <key_id>.<key_secret>" };
    let scopes: string[];
    try {
      scopes = (await new DzbuildClient(key).whoami()).scopes;
    } catch (err) {
      return { ok: false, message: `DZBuild rejected the key: ${(err as Error).message}` };
    }
    const secret = newWebhookSecret();
    await prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { credentials: encryptJson({ apiKey: key }), webhookSecret: secret.stored, connection: "CONNECTED", lastError: null } });
    await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { dzbuild: true, scopes } });
    revalidatePath(`/${ctx.locale}/settings/stores/${store.id}`);
    return { ok: true, data: { scopes, webhookUrl: `${process.env.APP_URL ?? ""}/api/webhooks/dzbuild/${store.id}`, webhookSecret: secret.plain } };
  });
}

export async function connectSheetAction(input: { storeId: string; url: string; hasHeader: boolean }): Promise<Result<{ rows: number }>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const ref = parseSheetRef(input.url);
    let rows: string[][];
    try {
      rows = await fetchSheetRows(ref.sheetId, ref.gid);
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const settings: StoreSettings = { ...storeSettings(store), sheet: { sheetId: ref.sheetId, gid: ref.gid, lastRow: input.hasHeader ? 1 : 0, hasHeader: input.hasHeader } };
    await prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { externalRef: ref.sheetId, settings: settings as Prisma.InputJsonValue, connection: "CONNECTED", lastError: null } });
    revalidatePath(`/${ctx.locale}/settings/stores/${store.id}`);
    return { ok: true, data: { rows: rows.length } };
  });
}

/** Manual "Sync now" (5-minute cooldown). */
export async function syncNowAction(input: { storeId: string }): Promise<Result<unknown>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    if (store.lastSyncAt && Date.now() - store.lastSyncAt.getTime() < 5 * 60_000) return { ok: false, message: "Last sync was less than 5 minutes ago" };
    if (store.channel === "SHOPIFY") {
      await enqueue("store.backfill", { storeId: store.id });
      return { ok: true, message: "queued" };
    }
    const r = store.channel === "DZBUILD" ? await withSystemContext("sync-now", () => pollDzbuild(store)) : store.channel === "GOOGLE_SHEET" ? await withSystemContext("sync-now", () => pollSheet(store)) : null;
    revalidatePath(`/${ctx.locale}/settings/stores/${store.id}`);
    return { ok: true, data: r };
  });
}

export async function saveMappingAction(input: { storeId: string; mapping: Record<string, string> }): Promise<Result> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const clean: FieldMapping = {};
    for (const [k, v] of Object.entries(input.mapping)) {
      if ((MAPPABLE_FIELDS as readonly string[]).includes(k) && v.trim()) clean[k as keyof FieldMapping] = v.trim().slice(0, 500);
    }
    await prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { fieldMapping: clean as Prisma.InputJsonValue } });
    await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { fieldMapping: Object.keys(clean) } });
    revalidatePath(`/${ctx.locale}/settings/stores/${store.id}`);
    return { ok: true };
  });
}

export interface PreviewRow {
  source: string;
  mapped: MappedOrder;
  problems: string[];
}

/** Live preview of a mapping on the last 5 payloads (webhooks) or the first 5 sheet rows. */
export async function previewMappingAction(input: { storeId: string; mapping: Record<string, string> }): Promise<Result<PreviewRow[]>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const tmp = { ...store, fieldMapping: input.mapping as Prisma.JsonValue };
    const out: PreviewRow[] = [];
    const check = (m: MappedOrder): string[] => {
      const problems: string[] = [];
      if (!m.phone || !normalizePhone(m.phone).valid) problems.push("INVALID_PHONE");
      problems.push(...validateAddress({ wilaya: m.wilaya, commune: m.commune, address: m.address, deliveryType: m.deliveryType }).errors);
      if (m.items.length === 0) problems.push("NO_ITEMS");
      return problems;
    };
    if (store.channel === "GOOGLE_SHEET") {
      const s = storeSettings(store).sheet;
      if (!s) return { ok: false, message: "Connect the sheet first" };
      const rows = await fetchSheetRows(s.sheetId, s.gid);
      for (const r of mapSheetRows(rows, input.mapping as FieldMapping, s.hasHeader === false ? 0 : 1, s.hasHeader !== false).slice(-5)) out.push({ source: `row ${r.rowNumber}`, mapped: r.mapped, problems: check(r.mapped) });
    } else {
      for (const p of await recentPayloads(store.id, ctx.accessibleMerchantIds)) {
        const m = mapForStore(tmp, p.payload);
        out.push({ source: `${p.topic} · ${p.receivedAt.toISOString()}`, mapped: m, problems: check(m) });
      }
    }
    return { ok: true, data: out };
  });
}

export async function saveStoreSettingsAction(input: { storeId: string; writeBack: NonNullable<StoreSettings["writeBack"]>; backfillDays?: number; active?: boolean }): Promise<Result> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const next: StoreSettings = { ...storeSettings(store), writeBack: input.writeBack, backfillDays: input.backfillDays ?? storeSettings(store).backfillDays };
    await prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { settings: next as Prisma.InputJsonValue, ...(input.active !== undefined ? { active: input.active } : {}) } });
    await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { writeBack: input.writeBack } });
    revalidatePath(`/${ctx.locale}/settings/stores/${store.id}`);
    return { ok: true };
  });
}

/** New landing-form / generic-webhook token and signing secret (shown once). */
export async function rotateIntakeAction(input: { storeId: string }): Promise<Result<{ token: string; webhookSecret: string; intakeUrl: string; webhookUrl: string }>> {
  return guard(async () => {
    const ctx = await ctxOrFail();
    const store = await requireStoreAdmin(ctx, input.storeId);
    const token = await rotateIntakeToken(store.id, store.merchantId);
    let webhookSecret = "";
    if (store.channel !== "DZBUILD" && store.channel !== "SHOPIFY") {
      const s = newWebhookSecret();
      webhookSecret = s.plain;
      await prisma.store.update({ where: { id: store.id, merchantId: store.merchantId }, data: { webhookSecret: s.stored } });
    }
    await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { intakeTokenRotated: true } });
    const base = process.env.APP_URL ?? "";
    return { ok: true, data: { token, webhookSecret, intakeUrl: `${base}/api/intake/${store.id}`, webhookUrl: `${base}/api/webhooks/store/${store.id}` } };
  });
}
