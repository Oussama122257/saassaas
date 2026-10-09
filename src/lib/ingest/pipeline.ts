import type { Order, Prisma, Store } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { createOrder, IntakeRefusedError, type CreateOrderInput } from "@/lib/orders/orderTransitions";
import { systemContext, ForbiddenError, type TenantContext } from "@/lib/tenant";
import { parseOrgSettings } from "@/lib/settings";
import { normalizeLatin } from "@/lib/wilayas";
import type { MappedItem, MappedOrder } from "./fieldMapping";

/**
 * One ingestion pipeline for every order source (Shopify, DZBuild, WooCommerce, Google Sheets,
 * public API, landing forms, manual form, CSV import). Steps:
 *   1. idempotency on (storeId, externalId) — webhooks arrive twice or out of order
 *   2. anti-fraud: max N orders per IP in H hours (public intake only)
 *   3. SKU resolution: learned SkuMapping → product/variant SKU → exact product name → unmatched line
 *   4. createOrder() — normalization, address validation, fake signals, blacklist, duplicates
 */

export class IntakeRateLimitedError extends Error {
  readonly code = "INTAKE_RATE_LIMITED";
  constructor(public readonly retryAfterSec: number) {
    super("Too many orders from this address, try again later");
    this.name = "IntakeRateLimitedError";
  }
}

export interface IngestMeta {
  clientIp?: string | null;
  /** public intake (landing form / public API): IP limit applies */
  publicIntake?: boolean;
  source?: string | null;
  flags?: string[];
}

export interface IngestResult {
  order: Order;
  created: boolean;
}

/** Fixed window per merchant + IP. Counts successful orders only (call after a successful create). */
export async function checkIpLimit(merchantId: string, ip: string, max: number, hours: number, now = new Date()): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const windowMs = hours * 3600_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const row = await prisma.intakeIpWindow.findUnique({ where: { merchantId_ip_windowStart: { merchantId, ip, windowStart } } });
  const retryAfterSec = Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000);
  return { allowed: (row?.count ?? 0) < max, retryAfterSec };
}

export async function recordIpHit(merchantId: string, ip: string, hours: number, now = new Date()): Promise<void> {
  const windowMs = hours * 3600_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  await prisma.intakeIpWindow.upsert({
    where: { merchantId_ip_windowStart: { merchantId, ip, windowStart } },
    create: { merchantId, ip, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });
}

interface ResolvedLines {
  items: CreateOrderInput["items"];
  unmatched: NonNullable<CreateOrderInput["unmatched"]>;
}

function skuKey(item: MappedItem): string {
  return (item.sku?.trim() || item.name.trim()).slice(0, 190);
}

export async function resolveItems(merchantId: string, lines: MappedItem[]): Promise<ResolvedLines> {
  const items: CreateOrderInput["items"] = [];
  const unmatched: NonNullable<CreateOrderInput["unmatched"]> = [];
  if (lines.length === 0) return { items, unmatched };
  const keys = [...new Set(lines.map(skuKey))];
  const skus = [...new Set(lines.map((l) => l.sku).filter((s): s is string => !!s))];
  const [mappings, products, variants] = await Promise.all([
    prisma.skuMapping.findMany({ where: { merchantId, externalSku: { in: keys } } }),
    prisma.product.findMany({ where: { merchantId, active: true }, select: { id: true, sku: true, name: true, price: true } }),
    skus.length ? prisma.productVariant.findMany({ where: { sku: { in: skus }, product: { merchantId } }, select: { id: true, productId: true, sku: true, name: true } }) : Promise.resolve([]),
  ]);
  const mapBySku = new Map(mappings.map((m) => [m.externalSku, m]));
  const productBySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!.toLowerCase(), p]));
  const nameKey = (n: string) => normalizeLatin(n) || n.trim().toLowerCase();
  const productByName = new Map(products.map((p) => [nameKey(p.name), p]));
  const variantBySku = new Map(variants.map((v) => [v.sku!.toLowerCase(), v]));

  for (const line of lines) {
    const key = skuKey(line);
    const unitPrice = line.unitPrice ?? undefined;
    if (line.productId) {
      items.push({ productId: line.productId, variantId: line.variantId ?? null, qty: line.qty, unitPrice });
      continue;
    }
    const learned = mapBySku.get(key);
    if (learned) {
      items.push({ productId: learned.productId, variantId: learned.variantId, qty: line.qty, unitPrice });
      continue;
    }
    const sku = line.sku?.toLowerCase();
    const v = sku ? variantBySku.get(sku) : undefined;
    if (v) {
      items.push({ productId: v.productId, variantId: v.id, qty: line.qty, unitPrice });
      continue;
    }
    const p = (sku ? productBySku.get(sku) : undefined) ?? productByName.get(nameKey(line.name));
    if (p) {
      items.push({ productId: p.id, variantId: null, qty: line.qty, unitPrice });
      continue;
    }
    unmatched.push({ externalSku: key, productName: line.name, variantName: line.variant, qty: line.qty, unitPrice: line.unitPrice });
  }
  return { items, unmatched };
}

/** Ingest one mapped order into a store. Idempotent on (storeId, externalId). */
export async function ingestOrder(store: Pick<Store, "id" | "merchantId" | "channel">, mapped: MappedOrder, meta: IngestMeta = {}): Promise<IngestResult> {
  return withSystemContext(`ingest:${store.channel}`, async () => {
    if (mapped.externalId) {
      const existing = await prisma.order.findFirst({ where: { storeId: store.id, externalId: mapped.externalId, merchantId: store.merchantId } });
      if (existing) return { order: existing, created: false };
    }
    if (!mapped.phone) throw new IntakeValidationError("A phone number is required");

    const merchant = await prisma.organization.findUnique({ where: { id: store.merchantId }, select: { settings: true } });
    const settings = parseOrgSettings(merchant?.settings);
    const ip = meta.clientIp?.trim();
    if (meta.publicIntake && ip && settings.intake.ipLimitEnabled) {
      const limit = await checkIpLimit(store.merchantId, ip, settings.intake.ipLimitMax, settings.intake.ipLimitHours);
      if (!limit.allowed) throw new IntakeRateLimitedError(limit.retryAfterSec);
    }

    const { items, unmatched } = await resolveItems(store.merchantId, mapped.items);
    if (items.length === 0 && unmatched.length === 0) throw new IntakeValidationError("An order needs at least one product line");

    const subtotalFromLines = [...items.map((i) => (i.unitPrice ?? 0) * i.qty), ...unmatched.map((u) => (u.unitPrice ?? 0) * u.qty)].reduce((a, b) => a + b, 0);
    const shippingFee = mapped.shippingFee ?? (mapped.total !== null && subtotalFromLines > 0 && mapped.total > subtotalFromLines ? mapped.total - subtotalFromLines : 0);

    try {
      const order = await createOrder(systemContext(`ingest:${store.channel}`), {
        merchantId: store.merchantId,
        storeId: store.id,
        externalId: mapped.externalId,
        customer: { name: mapped.customerName, phone: mapped.phone, phone2: mapped.phone2 },
        wilaya: mapped.wilaya,
        commune: mapped.commune,
        address: mapped.address,
        address2: mapped.address2,
        landmark: mapped.landmark,
        deliveryType: mapped.deliveryType,
        items,
        unmatched,
        shippingFee,
        totalOverride: mapped.total,
        note: mapped.note,
        source: meta.source ?? mapped.source,
        flags: meta.flags,
        clientIp: ip ?? null,
        createdAt: mapped.createdAt && mapped.createdAt < new Date() ? mapped.createdAt : undefined,
      });
      if (mapped.externalName) await prisma.order.update({ where: { id: order.id, merchantId: order.merchantId }, data: { externalName: mapped.externalName } });
      if (meta.publicIntake && ip && settings.intake.ipLimitEnabled) await recordIpHit(store.merchantId, ip, settings.intake.ipLimitHours);
      return { order, created: true };
    } catch (err) {
      // concurrent duplicate webhook: the unique (storeId, externalId) index won the race
      const code = (err as { code?: string }).code;
      if (code === "P2002" && mapped.externalId) {
        const existing = await prisma.order.findFirst({ where: { storeId: store.id, externalId: mapped.externalId, merchantId: store.merchantId } });
        if (existing) return { order: existing, created: false };
      }
      throw err;
    }
  });
}

export class IntakeValidationError extends Error {
  readonly code = "INTAKE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

export { IntakeRefusedError };

/**
 * Resolve an unmatched line once: create the order item, remember the mapping for future orders
 * (auto-applied), and clear UNMATCHED_SKU when nothing is left unresolved.
 */
export async function resolveUnmatchedLine(ctx: TenantContext, input: { lineId: string; productId: string; variantId?: string | null; remember?: boolean }): Promise<void> {
  if (!["ORG_OWNER", "SUPERVISOR", "CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "PLATFORM_ADMIN"].includes(ctx.role) && !ctx.isPlatformAdmin) throw new ForbiddenError();
  const line = await prisma.unmatchedLine.findFirst({ where: { id: input.lineId, order: { merchantId: { in: ctx.accessibleMerchantIds } } }, include: { order: true } });
  if (!line || line.resolvedProductId) throw new ForbiddenError("Line not found");
  const product = await prisma.product.findFirst({ where: { id: input.productId, merchantId: line.order.merchantId } });
  if (!product) throw new ForbiddenError("Product not found for this merchant");
  await prisma.$transaction(async (tx) => {
    await tx.orderItem.create({ data: { orderId: line.orderId, productId: product.id, variantId: input.variantId ?? null, qty: line.qty, unitPrice: line.unitPrice || product.price } });
    await tx.unmatchedLine.update({ where: { id: line.id, orderId: line.orderId }, data: { resolvedProductId: product.id, resolvedVariantId: input.variantId ?? null } });
    if (input.remember !== false) {
      await tx.skuMapping.upsert({
        where: { merchantId_externalSku: { merchantId: line.order.merchantId, externalSku: line.externalSku } },
        create: { merchantId: line.order.merchantId, storeId: line.order.storeId, externalSku: line.externalSku, productId: product.id, variantId: input.variantId ?? null },
        update: { productId: product.id, variantId: input.variantId ?? null },
      });
    }
    const left = await tx.unmatchedLine.count({ where: { orderId: line.orderId, resolvedProductId: null } });
    const data: Prisma.OrderUpdateInput = { lastActivityAt: new Date() };
    if (left === 0) {
      data.mappingErrors = line.order.mappingErrors.filter((e) => e !== "UNMATCHED_SKU");
      data.flags = line.order.flags.filter((f) => f !== "UNMATCHED");
    }
    await tx.order.update({ where: { id: line.orderId, merchantId: line.order.merchantId }, data });
    await tx.orderEvent.create({ data: { orderId: line.orderId, actorId: ctx.userId, type: "FIELD_EDIT", payload: { unmatchedLine: line.externalSku, productId: product.id, remembered: input.remember !== false } } });
  });
}
