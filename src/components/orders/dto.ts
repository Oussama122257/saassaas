import type { OrderListRow } from "@/lib/orders/repository";

/** Plain, serializable row for client components. */
export interface OrderRowDto {
  id: string;
  seq: number;
  createdAt: string;
  lastActivityAt: string;
  customerName: string | null;
  customerPhone: string;
  items: string;
  wilayaCode: number;
  commune: string | null;
  total: number;
  status: OrderListRow["status"];
  assignedTo: string | null;
  assignedToId: string | null;
  store: string;
  attemptCount: number;
  trackingNumber: string | null;
  flags: string[];
  deliveryType: OrderListRow["deliveryType"];
  isRepeatCustomer: boolean;
  mappingErrors: string[];
}

export function toOrderRowDto(r: OrderListRow): OrderRowDto {
  return {
    id: r.id,
    seq: r.seq,
    createdAt: r.createdAt.toISOString(),
    lastActivityAt: r.lastActivityAt.toISOString(),
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    items: r.items.map((i) => `${i.qty}× ${i.product.name}${i.variant ? ` (${i.variant.name})` : ""}`).join(", "),
    wilayaCode: r.wilayaCode,
    commune: r.commune,
    total: r.total,
    status: r.status,
    assignedTo: r.assignedTo?.name ?? null,
    assignedToId: r.assignedToId,
    store: r.store.name,
    attemptCount: r.attemptCount,
    trackingNumber: r.trackingNumber,
    flags: r.flags,
    deliveryType: r.deliveryType,
    isRepeatCustomer: r.isRepeatCustomer,
    mappingErrors: r.mappingErrors,
  };
}
