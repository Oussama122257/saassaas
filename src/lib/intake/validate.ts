import type { FakeReason } from "@prisma/client";
import { normalizePhone } from "@/lib/phone";
import { WILAYAS, normalizeArabic, normalizeLatin, resolveWilayaCode } from "@/lib/wilayas";

/**
 * Intake field validation (sections 12.1, 19b.4, 19c.4). Pure functions; createOrder() applies them.
 */

export type MappingError =
  | "ADDRESS_MAPPING"
  | "UNKNOWN_WILAYA"
  | "COMMUNE_WILAYA_MISMATCH"
  | "ADDRESS_EMPTY"
  | "INVALID_PHONE"
  | "NON_ALGERIAN_PHONE"
  | "UNMATCHED_SKU";

const SIZE_COLOR_PATTERNS: RegExp[] = [
  /^(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl)$/i,
  /\b(taille|size|pointure|couleur|color|colour)\b/i,
  /(مقاس|المقاس|اللون|لون\s)/,
  /^\d{2,3}\s*(cm|eu)$/i,
  /\b(noir|blanc|rouge|bleu|vert|gris|rose|beige|marron|jaune|black|white|red|blue|green|grey|gray|pink)\b/i,
  /(أسود|أبيض|احمر|أحمر|أزرق|ازرق|أخضر|اخضر|رمادي|وردي|بني)/,
];

/** Text that looks like a size / colour / quantity rather than a place name. */
export function looksLikeVariantText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (/^\d+$/.test(t) && Number(t) > 58) return true;
  return SIZE_COLOR_PATTERNS.some((re) => re.test(t));
}

/** Find a wilaya mentioned anywhere inside a free-text field (auto-repair). */
export function findWilayaInText(text: string | null | undefined): number | null {
  if (!text) return null;
  const direct = resolveWilayaCode(text);
  if (direct) return direct;
  const latin = normalizeLatin(text);
  const arabic = normalizeArabic(text);
  let best: { code: number; len: number } | null = null;
  for (const w of WILAYAS) {
    const fr = normalizeLatin(w.nameFr);
    const ar = normalizeArabic(w.nameAr);
    if (fr.length >= 4 && latin.includes(fr) && (!best || fr.length > best.len)) best = { code: w.code, len: fr.length };
    if (ar.length >= 3 && arabic.includes(ar) && (!best || ar.length > best.len)) best = { code: w.code, len: ar.length };
  }
  return best?.code ?? null;
}

export interface CommuneRef {
  wilayaCode: number;
  nameFr: string;
  nameAr: string;
}

export interface AddressInput {
  wilaya: string | number | null | undefined;
  commune?: string | null;
  address?: string | null;
  address2?: string | null;
  landmark?: string | null;
  deliveryType?: "HOME" | "STOP_DESK";
}

export interface AddressResult {
  wilayaCode: number | null;
  commune: string | null;
  repaired: boolean;
  errors: MappingError[];
  notes: string[];
}

function matchCommune(name: string, communes: CommuneRef[]): CommuneRef[] {
  const latin = normalizeLatin(name);
  const arabic = normalizeArabic(name);
  return communes.filter((c) => (latin && normalizeLatin(c.nameFr) === latin) || (arabic && normalizeArabic(c.nameAr) === arabic));
}

/**
 * Validate and, where safe, repair the address block:
 *  - wilaya resolves to 1..58 (numeric, FR, AR); size/colour text in the wilaya field is detected
 *  - when the wilaya is missing or polluted, look for it in commune/address/landmark (auto-repair)
 *  - a commune that belongs to another wilaya (and not to this one) is a mismatch
 *  - home delivery needs a non-empty address
 */
export function validateAddress(input: AddressInput, communes: CommuneRef[] = []): AddressResult {
  const errors: MappingError[] = [];
  const notes: string[] = [];
  let repaired = false;
  let commune = input.commune?.trim() || null;

  const rawWilaya = input.wilaya;
  let wilayaCode = typeof rawWilaya === "number" ? resolveWilayaCode(rawWilaya) : resolveWilayaCode(rawWilaya ?? null);
  const polluted = typeof rawWilaya === "string" && looksLikeVariantText(rawWilaya);

  if (!wilayaCode) {
    // auto-repair: commune / address / landmark may hold the wilaya
    const fromOther = findWilayaInText(commune) ?? findWilayaInText(input.address) ?? findWilayaInText(input.address2) ?? findWilayaInText(input.landmark);
    const fromCommuneTable = commune ? [...new Set(matchCommune(commune, communes).map((c) => c.wilayaCode))] : [];
    const inferred = fromOther ?? (fromCommuneTable.length === 1 ? fromCommuneTable[0]! : null);
    if (inferred) {
      wilayaCode = inferred;
      repaired = true;
      notes.push(polluted ? `wilaya field held "${String(rawWilaya)}"; wilaya ${inferred} found in other fields` : `wilaya ${inferred} inferred from other fields`);
    } else {
      errors.push(polluted ? "ADDRESS_MAPPING" : "UNKNOWN_WILAYA");
      if (polluted) notes.push(`wilaya field holds variant text "${String(rawWilaya)}"`);
    }
  }

  if (wilayaCode && commune) {
    // commune field holding a wilaya name different from the wilaya → swapped/polluted fields
    const communeAsWilaya = resolveWilayaCode(commune);
    const matches = matchCommune(commune, communes);
    const inThisWilaya = matches.some((c) => c.wilayaCode === wilayaCode);
    if (!inThisWilaya && matches.length > 0) {
      errors.push("COMMUNE_WILAYA_MISMATCH");
      notes.push(`commune "${commune}" belongs to wilaya ${matches.map((m) => m.wilayaCode).join("/")}`);
    } else if (!inThisWilaya && communeAsWilaya && communeAsWilaya !== wilayaCode) {
      errors.push("ADDRESS_MAPPING");
      notes.push(`commune field holds another wilaya name "${commune}"`);
    } else if (looksLikeVariantText(commune)) {
      errors.push("ADDRESS_MAPPING");
      notes.push(`commune field holds variant text "${commune}"`);
      commune = null;
    }
  }

  if ((input.deliveryType ?? "HOME") === "HOME" && !(input.address?.trim() || input.address2?.trim())) {
    errors.push("ADDRESS_EMPTY");
  }
  return { wilayaCode, commune, repaired, errors: [...new Set(errors)], notes };
}

const NONSENSE_NAMES = new Set(["test", "testing", "azerty", "qwerty", "asdf", "aaaa", "xxx", "xxxx", "abc", "toto", "fake", "none", "null", "na", "n/a", "client"]);

/** Obvious fake signals (section 12.1). Returns the reasons found; empty = looks fine. */
export function detectFakeSignals(input: { name?: string | null; phone: string; note?: string | null }): FakeReason[] {
  const reasons: FakeReason[] = [];
  const phone = normalizePhone(input.phone);
  if (!phone.valid) reasons.push("INVALID_PHONE");
  else if (phone.phone && /^0[567](\d)\1{7}$/.test(phone.phone)) reasons.push("INVALID_PHONE");
  else if (phone.phone && /^0[567](12345678|87654321)$/.test(phone.phone)) reasons.push("INVALID_PHONE");

  const name = (input.name ?? "").trim();
  const lower = name.toLowerCase();
  if (/\btest\b/i.test(name) || /\btest\b/i.test(input.note ?? "")) reasons.push("TEST_ORDER");
  else if (name) {
    const letters = name.replace(/[^\p{L}]/gu, "");
    if (letters.length < 2) reasons.push("NAME_NONSENSE");
    else if (NONSENSE_NAMES.has(lower)) reasons.push("NAME_NONSENSE");
    else if (/^(.)\1{2,}$/u.test(letters)) reasons.push("NAME_NONSENSE");
    else if (/[bcdfghjklmnpqrstvwxz]{6,}/i.test(letters)) reasons.push("NAME_NONSENSE");
  }
  return [...new Set(reasons)];
}

/** Mobile check for messaging and "Algerian phones only" intake. */
export function isAlgerianNumber(phone: string): boolean {
  const n = normalizePhone(phone);
  return n.valid;
}
