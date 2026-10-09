import { z } from "zod";

/**
 * Zod schemas of the public API (section 19b.6). Shared by the route handlers and the generated
 * OpenAPI document, so the reference never drifts from what the server validates.
 */
export const createOrderBody = z
  .object({
    store_id: z.string().min(1).describe("Store that receives the order"),
    external_id: z.string().max(190).optional().describe("Your order id; makes the call idempotent per store"),
    external_name: z.string().max(190).optional(),
    customer: z.object({
      name: z.string().max(190).optional(),
      phone: z.string().min(6).max(30).describe("Algerian phone, any format (0X…, +213…)"),
      phone2: z.string().max(30).optional(),
    }),
    shipping: z.object({
      wilaya: z.union([z.number().int().min(1).max(58), z.string().min(1).max(100)]).describe("Code 1–58 or name (FR/AR)"),
      commune: z.string().max(190).optional(),
      address: z.string().max(500).optional(),
      address2: z.string().max(500).optional(),
      landmark: z.string().max(500).optional(),
      delivery_type: z.enum(["HOME", "STOP_DESK"]).default("HOME"),
      fee: z.number().int().min(0).optional().describe("Shipping fee in DZD"),
      free_delivery: z.boolean().optional(),
    }),
    items: z
      .array(
        z.object({
          product_id: z.string().optional(),
          sku: z.string().max(190).optional(),
          name: z.string().max(190).optional(),
          variant: z.string().max(190).optional(),
          qty: z.number().int().min(1).max(100).default(1),
          unit_price: z.number().int().min(0).optional(),
        }),
      )
      .min(1)
      .max(50),
    total: z.number().int().min(0).optional().describe("Total to collect at the door (DZD); defaults to items + shipping"),
    note: z.string().max(2000).optional(),
    source: z.string().max(190).optional().describe("utm / campaign / ad id"),
    client_ip: z.string().max(64).optional().describe("Buyer IP (anti-fraud IP limit)"),
    abandoned_cart_recovery: z.boolean().optional(),
  })
  .describe("Create an order");

export type CreateOrderBody = z.infer<typeof createOrderBody>;
