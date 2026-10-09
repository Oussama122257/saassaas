import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/crypto";
import { applyMapping, type FieldMapping, type MappedOrder } from "@/lib/ingest/fieldMapping";
import { AdapterError, readJson, sleep, type FetchLike } from "./http";

/**
 * Shopify (section 12.5). GraphQL Admin API only, version pinned with SHOPIFY_API_VERSION.
 * References:
 *  - OAuth (authorization code grant): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 *  - Webhook HMAC (X-Shopify-Hmac-Sha256, base64 HMAC-SHA256 of the raw body): https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-5-verify-the-webhook
 *  - Rate limits (cost-based, extensions.cost.throttleStatus): https://shopify.dev/docs/api/usage/rate-limits
 *  - fulfillmentCreate: https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
 * Every mutation used below carries a link; verify each against the pinned version when upgrading.
 */
export const SHOPIFY_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "products/create",
  "products/update",
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export function apiVersion(): string {
  return process.env.SHOPIFY_API_VERSION || "2026-07";
}

export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

// ─────────────────────────────── webhooks ───────────────────────────────

/** Verify X-Shopify-Hmac-Sha256 (base64 HMAC-SHA256 of the raw body with the app secret). */
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqual(digest, hmacHeader.trim());
}

export function signShopifyWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

// ─────────────────────────────── OAuth ───────────────────────────────

export function buildInstallUrl(params: { shop: string; apiKey: string; scopes: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ client_id: params.apiKey, scope: params.scopes, redirect_uri: params.redirectUri, state: params.state });
  return `https://${params.shop}/admin/oauth/authorize?${q.toString()}`;
}

/** OAuth callback query HMAC: hex HMAC-SHA256 of the sorted query string without `hmac`. */
export function verifyOAuthQuery(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get("hmac");
  if (!hmac) return false;
  const message = [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", secret).update(message).digest("hex");
  return safeEqual(digest, hmac);
}

export async function exchangeOAuthCode(params: { shop: string; apiKey: string; apiSecret: string; code: string; fetchImpl?: FetchLike }): Promise<{ accessToken: string; scope: string }> {
  const f = params.fetchImpl ?? fetch;
  const res = await f(`https://${params.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: params.apiKey, client_secret: params.apiSecret, code: params.code }),
  });
  const body = await readJson<{ access_token?: string; scope?: string; error?: string }>(res, "shopify");
  if (!res.ok || !body.access_token) throw new AdapterError("shopify", `OAuth exchange failed: ${body.error ?? res.status}`, res.status);
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}

// ─────────────────────────────── mapping ───────────────────────────────

/**
 * Default mapping for the webhook (REST JSON) order payload. Stores using COD form apps override
 * single fields from the field-mapping screen (e.g. wilaya → note_attributes[name=Wilaya].value).
 */
export const SHOPIFY_DEFAULT_MAPPING: FieldMapping = {
  externalId: "admin_graphql_api_id|id",
  externalName: "name",
  customerName: "shipping_address.name|billing_address.name|customer.first_name",
  phone: "shipping_address.phone|phone|customer.phone|billing_address.phone|note_attributes[name=phone].value|note_attributes[name=Téléphone].value",
  phone2: "note_attributes[name=phone2].value",
  wilaya: "shipping_address.province|note_attributes[name=wilaya].value|note_attributes[name=Wilaya].value|shipping_address.province_code",
  commune: "shipping_address.city|note_attributes[name=commune].value|note_attributes[name=Commune].value",
  address: "shipping_address.address1|note_attributes[name=address].value",
  address2: "shipping_address.address2",
  deliveryType: "note_attributes[name=delivery_type].value|shipping_lines[0].title",
  shippingFee: "shipping_lines[0].price|total_shipping_price_set.shop_money.amount",
  total: "current_total_price|total_price",
  note: "note",
  source: "source_name|landing_site",
  items: "line_items",
  itemSku: "sku",
  itemName: "title|name",
  itemVariant: "variant_title",
  itemQty: "quantity",
  itemPrice: "price",
  createdAt: "created_at",
};

export function mapShopifyOrder(payload: unknown, overrides?: FieldMapping | null): MappedOrder {
  const mapped = applyMapping(payload, { ...SHOPIFY_DEFAULT_MAPPING, ...(overrides ?? {}) });
  // customer name fallback: first + last name
  if (!mapped.customerName) {
    const p = payload as { customer?: { first_name?: string; last_name?: string } };
    const n = [p.customer?.first_name, p.customer?.last_name].filter(Boolean).join(" ").trim();
    mapped.customerName = n || null;
  }
  return mapped;
}

/** Convert a GraphQL order node (backfill) to the webhook-shaped payload so one mapping serves both. */
export function graphqlOrderToRest(node: ShopifyOrderNode): Record<string, unknown> {
  const money = (m?: { shopMoney?: { amount?: string } } | null) => m?.shopMoney?.amount ?? null;
  return {
    admin_graphql_api_id: node.id,
    name: node.name,
    created_at: node.createdAt,
    note: node.note,
    source_name: node.sourceName,
    note_attributes: (node.customAttributes ?? []).map((a) => ({ name: a.key, value: a.value })),
    total_price: money(node.totalPriceSet),
    shipping_lines: [{ price: money(node.totalShippingPriceSet), title: node.shippingLine?.title ?? null }],
    shipping_address: node.shippingAddress
      ? { name: node.shippingAddress.name, phone: node.shippingAddress.phone, province: node.shippingAddress.province, city: node.shippingAddress.city, address1: node.shippingAddress.address1, address2: node.shippingAddress.address2 }
      : null,
    customer: node.customer ? { first_name: node.customer.firstName, last_name: node.customer.lastName, phone: node.customer.phone } : null,
    line_items: (node.lineItems?.nodes ?? []).map((li) => ({ sku: li.sku, title: li.title, variant_title: li.variantTitle, quantity: li.quantity, price: money(li.originalUnitPriceSet) })),
  };
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  createdAt: string;
  note?: string | null;
  sourceName?: string | null;
  tags?: string[];
  customAttributes?: Array<{ key: string; value: string | null }>;
  totalPriceSet?: { shopMoney?: { amount?: string } } | null;
  totalShippingPriceSet?: { shopMoney?: { amount?: string } } | null;
  shippingLine?: { title?: string | null } | null;
  shippingAddress?: { name?: string | null; phone?: string | null; province?: string | null; city?: string | null; address1?: string | null; address2?: string | null } | null;
  customer?: { firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
  lineItems?: { nodes: Array<{ sku?: string | null; title: string; variantTitle?: string | null; quantity: number; originalUnitPriceSet?: { shopMoney?: { amount?: string } } | null }> };
}

// ─────────────────────────────── GraphQL client ───────────────────────────────

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable: number; restoreRate: number; maximumAvailable: number } } };
}

export class ShopifyClient {
  constructor(
    private readonly shop: string,
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly version = apiVersion(),
  ) {}

  /** POST /admin/api/{version}/graphql.json with cost-based throttling (back off and retry on THROTTLED). */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`https://${this.shop}/admin/api/${this.version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new AdapterError("shopify", `HTTP ${res.status}`, res.status);
      await sleep(1000 * 2 ** attempt);
      return this.graphql<T>(query, variables, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) throw new AdapterError("shopify", "Access token rejected (store disconnected?)", res.status);
    const body = await readJson<GraphqlResponse<T>>(res, "shopify");
    const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) {
      if (attempt >= 4) throw new AdapterError("shopify", "Throttled", 429);
      const t = body.extensions?.cost?.throttleStatus;
      const need = body.extensions?.cost?.requestedQueryCost ?? 50;
      const waitMs = t ? Math.ceil(Math.max(0, need - t.currentlyAvailable) / Math.max(1, t.restoreRate)) * 1000 : 2000;
      await sleep(Math.min(waitMs, 10_000));
      return this.graphql<T>(query, variables, attempt + 1);
    }
    if (body.errors?.length) throw new AdapterError("shopify", body.errors.map((e) => e.message).join("; "), res.status);
    // proactive backoff when the bucket is nearly empty
    const t = body.extensions?.cost?.throttleStatus;
    if (t && t.currentlyAvailable < 100) await sleep(Math.min(5000, Math.ceil((100 - t.currentlyAvailable) / Math.max(1, t.restoreRate)) * 1000));
    return body.data as T;
  }

  async shopName(): Promise<string> {
    const d = await this.graphql<{ shop: { name: string } }>(`query { shop { name } }`);
    return d.shop.name;
  }

  /** https://shopify.dev/docs/api/admin-graphql/latest/queries/products */
  async *products(): AsyncGenerator<{ id: string; title: string; variants: Array<{ id: string; title: string; sku: string | null; price: string }> }> {
    let cursor: string | null = null;
    do {
      const d: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; title: string; variants: { nodes: Array<{ id: string; title: string; sku: string | null; price: string }> } }> } } = await this.graphql(
        `query($cursor: String) { products(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id title variants(first: 50) { nodes { id title sku price } } } } }`,
        { cursor },
      );
      for (const p of d.products.nodes) yield { id: p.id, title: p.title, variants: p.variants.nodes };
      cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
    } while (cursor);
  }

  /** Open, unfulfilled orders created since `since` (backfill). https://shopify.dev/docs/api/admin-graphql/latest/queries/orders */
  async *openOrdersSince(since: Date): AsyncGenerator<ShopifyOrderNode> {
    let cursor: string | null = null;
    const q = `created_at:>=${since.toISOString().slice(0, 10)} AND status:open AND fulfillment_status:unfulfilled`;
    do {
      const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrderNode[] } } = await this.graphql(
        `query($cursor: String, $q: String) { orders(first: 50, after: $cursor, query: $q) { pageInfo { hasNextPage endCursor } nodes {
          id name createdAt note sourceName tags customAttributes { key value }
          totalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } } shippingLine { title }
          shippingAddress { name phone province city address1 address2 } customer { firstName lastName phone }
          lineItems(first: 50) { nodes { sku title variantTitle quantity originalUnitPriceSet { shopMoney { amount } } } } } } }`,
        { cursor, q },
      );
      for (const n of d.orders.nodes) yield n;
      cursor = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    } while (cursor);
  }

  /**
   * Replace our single `cc:<STATUS>` tag. https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd
   * and https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsRemove
   */
  async setStatusTag(orderGid: string, status: string): Promise<void> {
    const d = await this.graphql<{ order: { tags: string[] } | null }>(`query($id: ID!) { order(id: $id) { tags } }`, { id: orderGid });
    const ours = (d.order?.tags ?? []).filter((t) => t.startsWith("cc:") && t !== `cc:${status}`);
    if (ours.length) {
      const r = await this.graphql<{ tagsRemove: { userErrors: Array<{ message: string }> } }>(
        `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
        { id: orderGid, tags: ours },
      );
      if (r.tagsRemove.userErrors.length) throw new AdapterError("shopify", r.tagsRemove.userErrors[0]!.message);
    }
    const a = await this.graphql<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(
      `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: orderGid, tags: [`cc:${status}`] },
    );
    if (a.tagsAdd.userErrors.length) throw new AdapterError("shopify", a.tagsAdd.userErrors[0]!.message);
  }

  /** https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderUpdate (note) */
  async setNote(orderGid: string, note: string): Promise<void> {
    const r = await this.graphql<{ orderUpdate: { userErrors: Array<{ message: string }> } }>(
      `mutation($input: OrderInput!) { orderUpdate(input: $input) { userErrors { message } } }`,
      { input: { id: orderGid, note } },
    );
    if (r.orderUpdate.userErrors.length) throw new AdapterError("shopify", r.orderUpdate.userErrors[0]!.message);
  }

  /** https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCancel — TODO(owner): confirm arguments on the pinned version. */
  async cancel(orderGid: string): Promise<void> {
    const r = await this.graphql<{ orderCancel: { orderCancelUserErrors: Array<{ message: string }> } }>(
      `mutation($id: ID!) { orderCancel(orderId: $id, reason: CUSTOMER, refund: false, restock: true, notifyCustomer: false) { orderCancelUserErrors { message } } }`,
      { id: orderGid },
    );
    if (r.orderCancel.orderCancelUserErrors.length) throw new AdapterError("shopify", r.orderCancel.orderCancelUserErrors[0]!.message);
  }

  /**
   * Fulfill with tracking: query order.fulfillmentOrders then fulfillmentCreate with
   * lineItemsByFulfillmentOrder + trackingInfo, notifyCustomer off by default.
   * https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
   */
  async fulfill(orderGid: string, tracking: { company: string; number: string; url?: string }, notifyCustomer = false): Promise<string | null> {
    const d = await this.graphql<{ order: { fulfillmentOrders: { nodes: Array<{ id: string; status: string; assignedLocation?: { location?: { id: string } | null } | null }> } } | null }>(
      `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status assignedLocation { location { id } } } } } }`,
      { id: orderGid },
    );
    const open = (d.order?.fulfillmentOrders.nodes ?? []).filter((f) => ["OPEN", "IN_PROGRESS"].includes(f.status));
    if (open.length === 0) return null;
    // all fulfillment orders in one call must share the same location
    const location = open[0]!.assignedLocation?.location?.id;
    const sameLocation = open.filter((f) => f.assignedLocation?.location?.id === location);
    const r = await this.graphql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: Array<{ message: string }> } }>(
      `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { message } } }`,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: sameLocation.map((f) => ({ fulfillmentOrderId: f.id })),
          trackingInfo: { company: tracking.company, number: tracking.number, ...(tracking.url ? { url: tracking.url } : {}) },
          notifyCustomer,
        },
      },
    );
    if (r.fulfillmentCreate.userErrors.length) throw new AdapterError("shopify", r.fulfillmentCreate.userErrors[0]!.message);
    return r.fulfillmentCreate.fulfillment?.id ?? null;
  }

  /** COD captured on delivery. https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderMarkAsPaid — TODO(owner): confirm on the pinned version. */
  async markAsPaid(orderGid: string): Promise<void> {
    const r = await this.graphql<{ orderMarkAsPaid: { userErrors: Array<{ message: string }> } }>(
      `mutation($input: OrderMarkAsPaidInput!) { orderMarkAsPaid(input: $input) { userErrors { message } } }`,
      { input: { id: orderGid } },
    );
    if (r.orderMarkAsPaid.userErrors.length) throw new AdapterError("shopify", r.orderMarkAsPaid.userErrors[0]!.message);
  }

  /**
   * Subscribe a webhook. https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate
   * TODO(owner): recent API versions renamed `callbackUrl` to `uri` in WebhookSubscriptionInput — check the pinned version.
   */
  async subscribeWebhook(topic: string, callbackUrl: string): Promise<void> {
    const enumTopic = topic.toUpperCase().replace("/", "_");
    const r = await this.graphql<{ webhookSubscriptionCreate: { userErrors: Array<{ message: string }> } }>(
      `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } } }`,
      { topic: enumTopic, sub: { callbackUrl, format: "JSON" } },
    );
    const errs = r.webhookSubscriptionCreate.userErrors.filter((e) => !/already been taken/i.test(e.message));
    if (errs.length) throw new AdapterError("shopify", errs[0]!.message);
  }
}
