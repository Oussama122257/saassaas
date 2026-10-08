import type { OrderStatus, StatusGroup } from "@prisma/client";
import { isOrderStatus, STATUS_GROUPS } from "./statuses";
import { PAGE_SIZES, type ChipKey, type OrderFilters, type OrderSort } from "./repository";

export type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v) || undefined;

const SORTS: OrderSort[] = ["createdAt_desc", "createdAt_asc", "total_desc", "total_asc", "lastActivityAt_desc", "seq_desc", "seq_asc"];

export interface ParsedOrderQuery {
  filters: OrderFilters;
  page: number;
  pageSize: number;
  sort: OrderSort;
}

export function parseOrderSearchParams(sp: SearchParams): ParsedOrderQuery {
  const statusRaw = sp.status;
  const statuses = (Array.isArray(statusRaw) ? statusRaw : statusRaw ? statusRaw.split(",") : [])
    .map((s) => s.trim())
    .filter((s): s is OrderStatus => isOrderStatus(s));
  const group = one(sp.group);
  const chip = one(sp.chip);
  const wilaya = Number(one(sp.wilaya));
  const from = one(sp.from);
  const to = one(sp.to);
  const pageSize = Number(one(sp.pageSize));
  const sort = one(sp.sort);

  const filters: OrderFilters = {
    q: one(sp.q),
    status: statuses.length ? statuses : undefined,
    statusGroup: group && (STATUS_GROUPS as string[]).includes(group) ? (group as StatusGroup) : undefined,
    storeId: one(sp.store),
    merchantId: one(sp.merchant),
    assignedToId: one(sp.agent),
    podId: one(sp.pod),
    wilayaCode: Number.isInteger(wilaya) && wilaya >= 1 && wilaya <= 58 ? wilaya : undefined,
    courierId: one(sp.courier),
    from: from && !Number.isNaN(Date.parse(from)) ? new Date(from) : undefined,
    to: to && !Number.isNaN(Date.parse(to)) ? new Date(`${to}T23:59:59.999`) : undefined,
    chip: chip && (chip === "NOT_TREATED" || chip === "RETURN_ON_WAY" || chip === "SHIPPED_NO_SCAN_24H" || isOrderStatus(chip)) ? (chip as ChipKey) : undefined,
  };
  return {
    filters,
    page: Math.max(1, Number(one(sp.page)) || 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 50,
    sort: sort && (SORTS as string[]).includes(sort) ? (sort as OrderSort) : "createdAt_desc",
  };
}
