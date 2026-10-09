import { createHmac, randomUUID } from "node:crypto";
import { safeEqual } from "@/lib/crypto";
import { applyMapping, type FieldMapping, type MappedOrder } from "@/lib/ingest/fieldMapping";
import { AdapterError, readJson, sleep, type FetchLike } from "./http";

/**
 * DZBuild order source (section 12.7).
 * References: https://dzbuild.com/api-docs/intro (auth, base URL, rate limits) ·
 * https://dzbuild.com/api-docs/idempotency · https://dzbuild.com/api-docs/resources/orders ·
 * https://dzbuild.com/docs/addons/webhooks (X-DZ-Signature: t=…,v1=… = HMAC-SHA256 of "timestamp.rawBody").
 *
 * The spec lists the endpoints and headers used here. The order JSON field names are NOT in the
 * spec: the generic defaults below are a starting point and every field is editable from the
 * store's field-mapping screen. TODO(owner): confirm field names against the orders resource docs
 * with a real Enterprise key, then update DZBUILD_DEFAULT_MAPPING.
 */
export const DZBUILD_EVENTS = ["order.created", "order.confirmed", "order.processing", "order.shipped", "order.delivered", "order.cancelled", "order.returned", "webhook.verify", "webhook.test"] as const;
export type DzbuildStatus = "pending" | "confirmed" | "processing" | "shipped" | "delivered" | "cancelled" | "returned";

export const DZBUILD_DEFAULT_MAPPING: FieldMapping = {
  externalId: "id|order_id|reference",
  externalName: "number|reference|id",
  customerName: "customer.name|customer_name|full_name|name",
  phone: "customer.phone|customer_phone|phone",
  phone2: "customer.phone2|phone2|customer_phone_2",
  wilaya: "shipping.wilaya|wilaya|state|wilaya_name|wilaya_id",
  commune: "shipping.commune|commune|city|commune_name",
  address: "shipping.address|address",
  deliveryType: "shipping.type|delivery_type|stop_desk",
  shippingFee: "shipping.price|shipping_price|delivery_price|shipping_cost",
  total: "total|total_price|amount",
  note: "note|notes|comment",
  source: "source|utm_source",
  items: "items|products|line_items",
  itemSku: "sku|product.sku",
  itemName: "name|title|product.name",
  itemVariant: "variant|variant_name|options",
  itemQty: "quantity|qty",
  itemPrice: "price|unit_price",
  createdAt: "created_at|createdAt",
};

/** Webhook payloads wrap the order; accept {data:{…}}, {order:{…}} or the order itself. */
export function unwrapDzbuildOrder(payload: unknown): unknown {
  const p = payload as { data?: unknown; order?: unknown };
  if (p && typeof p === "object") {
    if (p.data && typeof p.data === "object") {
      const d = p.data as { order?: unknown };
      return d.order && typeof d.order === "object" ? d.order : p.data;
    }
    if (p.order && typeof p.order === "object") return p.order;
  }
  return payload;
}

export function mapDzbuildOrder(payload: unknown, overrides?: FieldMapping | null): MappedOrder {
  return applyMapping(unwrapDzbuildOrder(payload), { ...DZBUILD_DEFAULT_MAPPING, ...(overrides ?? {}) });
}

/** Parse "t=1700000000,v1=abcdef…" */
export function parseSignatureHeader(header: string | null): { t: number; v1: string } | null {
  if (!header) return null;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return null;
  return { t, v1: parts.v1 };
}

/** Verify X-DZ-Signature; reject when older than 5 minutes (replay protection). */
export function verifyDzbuildSignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): { ok: boolean; reason?: string } {
  const sig = parseSignatureHeader(header);
  if (!sig) return { ok: false, reason: "missing_signature" };
  if (Math.abs(nowSec - sig.t) > toleranceSec) return { ok: false, reason: "stale_timestamp" };
  const expected = createHmac("sha256", secret).update(`${sig.t}.${rawBody}`).digest("hex");
  return safeEqual(expected, sig.v1) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

export function signDzbuild(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export class DzbuildClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = process.env.DZBUILD_API_BASE || "https://api.dzbuild.app/v1",
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Idempotency-Key is required on every POST/PATCH/DELETE
    if (method !== "GET") headers["Idempotency-Key"] = (body as { _idem?: string } | undefined)?._idem ?? randomUUID();
    const payload = body && typeof body === "object" ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "_idem")) : body;
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (res.status === 429) {
      const b = await readJson<{ error?: { retry_after?: number } }>(res, "dzbuild");
      const retry = b.error?.retry_after ?? Number(res.headers.get("retry-after") ?? 5);
      if (attempt >= 3) throw new AdapterError("dzbuild", "rate_limited", 429, retry);
      await sleep(Math.min(retry, 30) * 1000);
      return this.request<T>(method, path, body, attempt + 1);
    }
    const json = await readJson<{ data?: T; error?: { code?: string; message?: string } }>(res, "dzbuild");
    if (!res.ok) throw new AdapterError("dzbuild", json.error?.message ?? json.error?.code ?? `HTTP ${res.status}`, res.status);
    return (json.data ?? (json as unknown)) as T;
  }

  ping() {
    return this.request<unknown>("GET", "/ping");
  }

  /** "Test connection": returns the key's scopes. */
  async whoami(): Promise<{ scopes: string[]; raw: unknown }> {
    const d = await this.request<{ scopes?: string[] }>("GET", "/whoami");
    return { scopes: d?.scopes ?? [], raw: d };
  }

  /** GET /v1/orders (limit 1–200, cursor, status, since) — safety polling. */
  async listOrders(params: { since?: Date; cursor?: string; limit?: number; status?: string }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const q = new URLSearchParams();
    q.set("limit", String(Math.min(200, Math.max(1, params.limit ?? 100))));
    if (params.since) q.set("since", params.since.toISOString());
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.status) q.set("status", params.status);
    const url = `/orders?${q.toString()}`;
    const res = await this.fetchImpl(`${this.base}${url}`, { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" } });
    const json = await readJson<{ data?: unknown[]; meta?: { next_cursor?: string | null; cursor?: string | null } }>(res, "dzbuild");
    if (!res.ok) throw new AdapterError("dzbuild", `HTTP ${res.status}`, res.status);
    return { items: json.data ?? [], nextCursor: json.meta?.next_cursor ?? json.meta?.cursor ?? null };
  }

  /** PATCH /v1/orders/{id} (status) with a deterministic Idempotency-Key per (order, status). */
  setStatus(id: string, status: DzbuildStatus, extra: Record<string, unknown> = {}) {
    return this.request<unknown>("PATCH", `/orders/${encodeURIComponent(id)}`, { status, ...extra, _idem: `cc-${id}-${status}` });
  }

  cancel(id: string) {
    return this.request<unknown>("POST", `/orders/${encodeURIComponent(id)}/cancel`, { _idem: `cc-${id}-cancel` });
  }
}

/** Our status → DZBuild status write-back (section 12.7). null = nothing to write. */
export function dzbuildStatusFor(code: string): DzbuildStatus | "cancel" | null {
  if (code.startsWith("CONFIRMEE")) return "confirmed";
  if (["ANNULEE", "FAUSSE_COMMANDE", "DOUBLE"].includes(code)) return "cancel";
  if (code === "EXPEDIE") return "shipped";
  if (code === "LIVRE") return "delivered";
  if (code === "RETOUR_RECU") return "returned";
  return null;
}
