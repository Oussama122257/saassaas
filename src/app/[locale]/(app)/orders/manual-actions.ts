"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { createOrder, IntakeRefusedError, OrderValidationError } from "@/lib/orders/orderTransitions";
import { ingestOrder } from "@/lib/ingest/pipeline";
import { applyMapping, type FieldMapping } from "@/lib/ingest/fieldMapping";
import { parseCsv } from "@/lib/csv";
import { isReadOnly, isSupervisorPlus } from "@/lib/tenant";

const manualSchema = z.object({
  storeId: z.string().min(1),
  externalId: z.string().max(190).optional(),
  name: z.string().max(190).optional(),
  phone: z.string().min(6).max(30),
  phone2: z.string().max(30).optional(),
  wilaya: z.coerce.number().int().min(1).max(58),
  commune: z.string().max(190).optional(),
  address: z.string().max(500).optional(),
  address2: z.string().max(500).optional(),
  landmark: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
  abandonedCartRecovery: z.boolean().default(false),
  deliveryType: z.enum(["HOME", "STOP_DESK"]),
  shippingFee: z.coerce.number().int().min(0).default(0),
  freeDelivery: z.boolean().default(false),
  items: z.array(z.object({ productId: z.string().min(1), variantId: z.string().optional(), qty: z.coerce.number().int().min(1).max(100), unitPrice: z.coerce.number().int().min(0).optional() })).min(1).max(20),
});

export type ManualOrderInput = z.input<typeof manualSchema>;
export type ManualOrderResult = { ok: true; orderId: string } | { ok: false; message: string; issues?: unknown };

/** Manual order form (section 19c.5) → the same createOrder() as every other source. */
export async function createManualOrderAction(input: ManualOrderInput): Promise<ManualOrderResult> {
  const ctx = await getCurrentContext();
  if (!ctx || isReadOnly(ctx) || ctx.role === "WAREHOUSE") return { ok: false, message: "Forbidden" };
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Invalid form", issues: parsed.error.issues };
  const d = parsed.data;
  const store = await prisma.store.findFirst({ where: { id: d.storeId, merchantId: { in: ctx.accessibleMerchantIds } } });
  if (!store) return { ok: false, message: "Store not found" };
  try {
    const order = await createOrder(ctx, {
      merchantId: store.merchantId,
      storeId: store.id,
      externalId: d.externalId || null,
      customer: { name: d.name || null, phone: d.phone, phone2: d.phone2 || null },
      wilaya: d.wilaya,
      commune: d.commune || null,
      address: d.address || null,
      address2: d.address2 || null,
      landmark: d.landmark || null,
      deliveryType: d.deliveryType,
      items: d.items.map((i) => ({ productId: i.productId, variantId: i.variantId || null, qty: i.qty, unitPrice: i.unitPrice })),
      shippingFee: d.shippingFee,
      freeDelivery: d.freeDelivery,
      abandonedCartRecovery: d.abandonedCartRecovery,
      note: d.note || null,
      source: d.abandonedCartRecovery ? "abandoned_cart" : "manual",
      flags: d.abandonedCartRecovery ? ["ABANDONED_CART"] : [],
    });
    revalidatePath(`/${ctx.locale}/orders`);
    return { ok: true, orderId: order.id };
  } catch (err) {
    if (err instanceof OrderValidationError || err instanceof IntakeRefusedError) return { ok: false, message: err.message };
    if ((err as { code?: string }).code === "P2002") return { ok: false, message: "An order with this external id already exists in this store" };
    throw err;
  }
}

/** Header names accepted by the CSV import (FR / EN / AR), mapped to our fields. */
const IMPORT_HEADERS: Record<string, keyof FieldMapping> = {
  external_id: "externalId", id: "externalId", reference: "externalId",
  name: "customerName", nom: "customerName", client: "customerName", "الاسم": "customerName",
  phone: "phone", telephone: "phone", "téléphone": "phone", tel: "phone", "الهاتف": "phone",
  phone2: "phone2", telephone2: "phone2",
  wilaya: "wilaya", "الولاية": "wilaya",
  commune: "commune", "البلدية": "commune",
  address: "address", adresse: "address", "العنوان": "address",
  address2: "address2", landmark: "landmark", repere: "landmark",
  delivery_type: "deliveryType", livraison: "deliveryType",
  shipping_fee: "shippingFee", frais: "shippingFee",
  total: "total", note: "note", remarque: "note", source: "source",
  sku: "itemSku", product: "itemName", produit: "itemName", "المنتج": "itemName",
  variant: "itemVariant", taille: "itemVariant", qty: "itemQty", quantite: "itemQty", "quantité": "itemQty", price: "itemPrice", prix: "itemPrice",
};

export interface ImportResult {
  ok: boolean;
  created: number;
  existing: number;
  errors: Array<{ row: number; message: string }>;
  message?: string;
}

/** Excel/CSV import (section 19c.5): one order per row, idempotent on external_id per store. */
export async function importOrdersAction(input: { storeId: string; csv: string }): Promise<ImportResult> {
  const ctx = await getCurrentContext();
  if (!ctx || !isSupervisorPlus(ctx)) return { ok: false, created: 0, existing: 0, errors: [], message: "Forbidden" };
  const store = await prisma.store.findFirst({ where: { id: input.storeId, merchantId: { in: ctx.accessibleMerchantIds } } });
  if (!store) return { ok: false, created: 0, existing: 0, errors: [], message: "Store not found" };
  const rows = parseCsv(input.csv);
  const [header, ...body] = rows;
  if (!header || body.length === 0) return { ok: false, created: 0, existing: 0, errors: [], message: "Empty file" };
  if (body.length > 2000) return { ok: false, created: 0, existing: 0, errors: [], message: "Max 2000 rows per import" };
  const mapping: FieldMapping = {};
  header.forEach((h, i) => {
    const key = IMPORT_HEADERS[h.trim().toLowerCase()];
    if (key && !mapping[key]) mapping[key] = `c${i}`;
  });
  if (!mapping.phone) return { ok: false, created: 0, existing: 0, errors: [], message: "A phone column is required" };
  const result: ImportResult = { ok: true, created: 0, existing: 0, errors: [] };
  for (const [idx, row] of body.entries()) {
    const obj = Object.fromEntries(row.map((v, i) => [`c${i}`, v]));
    const mapped = applyMapping(obj, mapping);
    if (!mapped.externalId) mapped.externalId = `import-${Date.now()}-${idx + 2}`;
    try {
      const r = await ingestOrder(store, mapped, { source: mapped.source ?? "import" });
      if (r.created) result.created++;
      else result.existing++;
    } catch (err) {
      result.errors.push({ row: idx + 2, message: (err as Error).message });
    }
  }
  revalidatePath(`/${ctx.locale}/orders`);
  return result;
}
