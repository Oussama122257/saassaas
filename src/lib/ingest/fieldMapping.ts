/**
 * Field mapping (sections 12.5, 19c.5): a per-store map "our field → source path" so new store
 * platforms and COD form apps are configuration, not code.
 *
 * Path syntax:
 *   shipping_address.province            dot access
 *   line_items[0].sku                    array index
 *   note_attributes[name=Wilaya].value   first array element whose `name` equals "Wilaya" (case-insensitive)
 *   shipping_address.phone | customer.phone   alternatives: first non-empty value wins
 *   ="STOP_DESK"                         literal
 *   columns.C                            Google Sheets column letter (rows are mapped to {columns:{A:..}})
 */
export const MAPPABLE_FIELDS = [
  "externalId",
  "externalName",
  "customerName",
  "phone",
  "phone2",
  "wilaya",
  "commune",
  "address",
  "address2",
  "landmark",
  "deliveryType",
  "shippingFee",
  "total",
  "note",
  "source",
  "items",
  "itemSku",
  "itemName",
  "itemVariant",
  "itemQty",
  "itemPrice",
  "createdAt",
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];
export type FieldMapping = Partial<Record<MappableField, string>>;

function segmentValue(current: unknown, segment: string): unknown {
  if (current === null || current === undefined) return undefined;
  const m = segment.match(/^([^[\]]*)((?:\[[^\]]+\])*)$/);
  if (!m) return undefined;
  let value: unknown = m[1] ? (current as Record<string, unknown>)[m[1]] : current;
  const brackets = m[2]?.match(/\[[^\]]+\]/g) ?? [];
  for (const b of brackets) {
    const inner = b.slice(1, -1);
    if (!Array.isArray(value)) return undefined;
    if (/^\d+$/.test(inner)) {
      value = value[Number(inner)];
      continue;
    }
    const eq = inner.indexOf("=");
    if (eq < 0) return undefined;
    const key = inner.slice(0, eq).trim();
    const expected = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, "").toLowerCase();
    value = value.find((el) => el && typeof el === "object" && String((el as Record<string, unknown>)[key] ?? "").toLowerCase() === expected);
  }
  return value;
}

/** Resolve one path (no alternatives) against a payload. */
export function getPath(payload: unknown, path: string): unknown {
  const p = path.trim();
  if (!p) return undefined;
  if (p.startsWith("=")) {
    const lit = p.slice(1).trim();
    try {
      return JSON.parse(lit);
    } catch {
      return lit;
    }
  }
  const segments: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of p) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "." && depth === 0) {
      segments.push(buf);
      buf = "";
    } else buf += ch;
  }
  segments.push(buf);
  let current: unknown = payload;
  for (const s of segments) {
    current = segmentValue(current, s);
    if (current === undefined) return undefined;
  }
  return current;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

/** Resolve a path expression with `|` alternatives. */
export function resolvePath(payload: unknown, expr: string | undefined): unknown {
  if (!expr) return undefined;
  for (const alt of expr.split("|")) {
    const v = getPath(payload, alt);
    if (!isEmpty(v)) return v;
  }
  return undefined;
}

export function asString(v: unknown): string | null {
  if (isEmpty(v)) return null;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** "1 500,00 DA" → 1500 ; 1500.5 → 1501 (DZD integers) */
export function asAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const s = asString(v);
  if (!s) return null;
  const cleaned = s.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  // "1.500,00" or "1,500.00" or "1500"
  const normalized = /,\d{1,2}$/.test(cleaned) ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export interface MappedItem {
  /** set when the source already knows our product id (public API) */
  productId?: string;
  variantId?: string | null;
  sku: string | null;
  name: string;
  variant: string | null;
  qty: number;
  unitPrice: number | null;
}

export interface MappedOrder {
  externalId: string | null;
  externalName: string | null;
  customerName: string | null;
  phone: string | null;
  phone2: string | null;
  wilaya: string | null;
  commune: string | null;
  address: string | null;
  address2: string | null;
  landmark: string | null;
  deliveryType: "HOME" | "STOP_DESK";
  shippingFee: number | null;
  total: number | null;
  note: string | null;
  source: string | null;
  items: MappedItem[];
  createdAt: Date | null;
}

const STOP_DESK_WORDS = /(stop\s*desk|bureau|desk|agence|office|مكتب|pickup|point\s*relais|relay)/i;

export function parseDeliveryType(v: unknown): "HOME" | "STOP_DESK" {
  const s = asString(v);
  if (!s) return "HOME";
  if (s === "1" || s.toUpperCase() === "STOP_DESK" || STOP_DESK_WORDS.test(s)) return "STOP_DESK";
  return "HOME";
}

/**
 * Apply a mapping to a payload. Items: either `items` points at an array and item* paths are
 * relative to each element, or item* paths are absolute (single-product landing forms).
 */
export function applyMapping(payload: unknown, mapping: FieldMapping): MappedOrder {
  const get = (f: MappableField) => resolvePath(payload, mapping[f]);
  const items: MappedItem[] = [];
  const list = mapping.items ? resolvePath(payload, mapping.items) : undefined;
  const elements: unknown[] = Array.isArray(list) ? list : [payload];
  for (const el of elements) {
    const name = asString(resolvePath(el, mapping.itemName)) ?? asString(resolvePath(el, mapping.itemSku));
    if (!name) continue;
    const qty = asAmount(resolvePath(el, mapping.itemQty)) ?? 1;
    items.push({
      sku: asString(resolvePath(el, mapping.itemSku)),
      name,
      variant: asString(resolvePath(el, mapping.itemVariant)),
      qty: qty > 0 ? qty : 1,
      unitPrice: asAmount(resolvePath(el, mapping.itemPrice)),
    });
  }
  const created = asString(get("createdAt"));
  const createdAt = created ? new Date(created) : null;
  return {
    externalId: asString(get("externalId")),
    externalName: asString(get("externalName")),
    customerName: asString(get("customerName")),
    phone: asString(get("phone")),
    phone2: asString(get("phone2")),
    wilaya: asString(get("wilaya")),
    commune: asString(get("commune")),
    address: asString(get("address")),
    address2: asString(get("address2")),
    landmark: asString(get("landmark")),
    deliveryType: parseDeliveryType(get("deliveryType")),
    shippingFee: asAmount(get("shippingFee")),
    total: asAmount(get("total")),
    note: asString(get("note")),
    source: asString(get("source")),
    items,
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
  };
}

/** Column letter helpers for Google Sheets rows. */
export function rowToColumns(row: string[]): { columns: Record<string, string> } {
  const columns: Record<string, string> = {};
  row.forEach((v, i) => {
    columns[columnLetter(i)] = v;
  });
  return { columns };
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
