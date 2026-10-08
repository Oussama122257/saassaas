/**
 * Algerian phone number normalization. Canonical format: 0XXXXXXXXX (10 digits for mobiles).
 * Accepts +213 / 00213 prefixes, spaces, dots, dashes and Arabic-Indic digits.
 */
export type PhoneType = "MOBILE" | "LANDLINE";

export interface NormalizedPhone {
  /** canonical number or null when it cannot be interpreted */
  phone: string | null;
  valid: boolean;
  type: PhoneType | null;
}

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export function toAsciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EASTERN_ARABIC_INDIC.indexOf(ch);
    if (a >= 0) out += String(a);
    else if (e >= 0) out += String(e);
    else out += ch;
  }
  return out;
}

export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (!raw) return { phone: null, valid: false, type: null };
  let digits = toAsciiDigits(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00213")) digits = digits.slice(5);
  else if (digits.startsWith("213") && digits.length >= 12) digits = digits.slice(3);
  if (digits.length === 9 && /^[1-9]/.test(digits)) digits = `0${digits}`;

  if (/^0[567]\d{8}$/.test(digits)) return { phone: digits, valid: true, type: "MOBILE" };
  // Landlines: 0 + 2-digit area code + 6 digits (9 digits), VoIP 098x/099x (10 digits)
  if (/^0[1-4]\d{7}$/.test(digits)) return { phone: digits, valid: true, type: "LANDLINE" };
  if (/^09\d{8}$/.test(digits)) return { phone: digits, valid: true, type: "LANDLINE" };
  return { phone: digits.length >= 8 ? digits : null, valid: false, type: null };
}

export function isAlgerianMobile(phone: string | null | undefined): boolean {
  return normalizePhone(phone).type === "MOBILE";
}

/** Mask for CLIENT_VIEWER exports: 05XX XX XX 34 → 05******34 */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return "*".repeat(phone.length);
  return `${phone.slice(0, 2)}${"*".repeat(phone.length - 4)}${phone.slice(-2)}`;
}

/** Human display: 0550 12 34 56 */
export function formatPhone(phone: string): string {
  if (/^0[567]\d{8}$/.test(phone)) {
    return `${phone.slice(0, 4)} ${phone.slice(4, 6)} ${phone.slice(6, 8)} ${phone.slice(8, 10)}`;
  }
  return phone;
}
