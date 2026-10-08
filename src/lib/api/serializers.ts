import type { OrderListRow } from "@/lib/orders/repository";
import { STATUS_META } from "@/lib/orders/statuses";

/** Public API representation of an order (snake_case, stable). */
export function serializeOrder(o: OrderListRow) {
  return {
    id: o.id,
    seq: o.seq,
    external_id: o.externalId,
    merchant_id: o.merchantId,
    store: { id: o.store.id, name: o.store.name, channel: o.store.channel },
    status: o.status,
    status_group: STATUS_META[o.status].group,
    customer: { name: o.customerName, phone: o.customerPhone, phone2: o.customerPhone2 },
    shipping: {
      wilaya_code: o.wilayaCode,
      commune: o.commune,
      address: o.address,
      landmark: o.landmark,
      delivery_type: o.deliveryType,
      courier: o.courier ? { id: o.courier.id, name: o.courier.name, provider: o.courier.provider } : null,
      tracking_number: o.trackingNumber,
    },
    items: o.items.map((i) => ({
      product_id: i.productId,
      product_name: i.product.name,
      variant_id: i.variantId,
      variant_name: i.variant?.name ?? null,
      qty: i.qty,
      unit_price: i.unitPrice,
    })),
    amounts: { subtotal: o.subtotal, shipping_fee: o.shippingFee, total: o.total, currency: "DZD" },
    assigned_to: o.assignedTo ? { id: o.assignedTo.id, name: o.assignedTo.name } : null,
    confirmed_by: o.confirmedBy ? { id: o.confirmedBy.id, name: o.confirmedBy.name } : null,
    attempts: { count: o.attemptCount, day: o.attemptDay, next_action_at: o.nextActionAt },
    cancel_reason: o.cancelReason,
    return_reason: o.returnReason,
    flags: o.flags,
    source: o.source,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    confirmed_at: o.confirmedAt,
    shipped_at: o.shippedAt,
    delivered_at: o.deliveredAt,
    returned_at: o.returnedAt,
  };
}
