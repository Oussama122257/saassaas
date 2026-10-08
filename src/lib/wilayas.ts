/**
 * The 58 wilayas of Algeria with French and Arabic names, plus a tolerant name → code resolver
 * used when ingesting orders (Shopify provinces, COD form apps, Google Sheets).
 */
export interface Wilaya {
  code: number;
  nameFr: string;
  nameAr: string;
}

export const WILAYAS: readonly Wilaya[] = [
  { code: 1, nameFr: "Adrar", nameAr: "أدرار" },
  { code: 2, nameFr: "Chlef", nameAr: "الشلف" },
  { code: 3, nameFr: "Laghouat", nameAr: "الأغواط" },
  { code: 4, nameFr: "Oum El Bouaghi", nameAr: "أم البواقي" },
  { code: 5, nameFr: "Batna", nameAr: "باتنة" },
  { code: 6, nameFr: "Béjaïa", nameAr: "بجاية" },
  { code: 7, nameFr: "Biskra", nameAr: "بسكرة" },
  { code: 8, nameFr: "Béchar", nameAr: "بشار" },
  { code: 9, nameFr: "Blida", nameAr: "البليدة" },
  { code: 10, nameFr: "Bouira", nameAr: "البويرة" },
  { code: 11, nameFr: "Tamanrasset", nameAr: "تمنراست" },
  { code: 12, nameFr: "Tébessa", nameAr: "تبسة" },
  { code: 13, nameFr: "Tlemcen", nameAr: "تلمسان" },
  { code: 14, nameFr: "Tiaret", nameAr: "تيارت" },
  { code: 15, nameFr: "Tizi Ouzou", nameAr: "تيزي وزو" },
  { code: 16, nameFr: "Alger", nameAr: "الجزائر" },
  { code: 17, nameFr: "Djelfa", nameAr: "الجلفة" },
  { code: 18, nameFr: "Jijel", nameAr: "جيجل" },
  { code: 19, nameFr: "Sétif", nameAr: "سطيف" },
  { code: 20, nameFr: "Saïda", nameAr: "سعيدة" },
  { code: 21, nameFr: "Skikda", nameAr: "سكيكدة" },
  { code: 22, nameFr: "Sidi Bel Abbès", nameAr: "سيدي بلعباس" },
  { code: 23, nameFr: "Annaba", nameAr: "عنابة" },
  { code: 24, nameFr: "Guelma", nameAr: "قالمة" },
  { code: 25, nameFr: "Constantine", nameAr: "قسنطينة" },
  { code: 26, nameFr: "Médéa", nameAr: "المدية" },
  { code: 27, nameFr: "Mostaganem", nameAr: "مستغانم" },
  { code: 28, nameFr: "M'Sila", nameAr: "المسيلة" },
  { code: 29, nameFr: "Mascara", nameAr: "معسكر" },
  { code: 30, nameFr: "Ouargla", nameAr: "ورقلة" },
  { code: 31, nameFr: "Oran", nameAr: "وهران" },
  { code: 32, nameFr: "El Bayadh", nameAr: "البيض" },
  { code: 33, nameFr: "Illizi", nameAr: "إليزي" },
  { code: 34, nameFr: "Bordj Bou Arréridj", nameAr: "برج بوعريريج" },
  { code: 35, nameFr: "Boumerdès", nameAr: "بومرداس" },
  { code: 36, nameFr: "El Tarf", nameAr: "الطارف" },
  { code: 37, nameFr: "Tindouf", nameAr: "تندوف" },
  { code: 38, nameFr: "Tissemsilt", nameAr: "تيسمسيلت" },
  { code: 39, nameFr: "El Oued", nameAr: "الوادي" },
  { code: 40, nameFr: "Khenchela", nameAr: "خنشلة" },
  { code: 41, nameFr: "Souk Ahras", nameAr: "سوق أهراس" },
  { code: 42, nameFr: "Tipaza", nameAr: "تيبازة" },
  { code: 43, nameFr: "Mila", nameAr: "ميلة" },
  { code: 44, nameFr: "Aïn Defla", nameAr: "عين الدفلى" },
  { code: 45, nameFr: "Naâma", nameAr: "النعامة" },
  { code: 46, nameFr: "Aïn Témouchent", nameAr: "عين تموشنت" },
  { code: 47, nameFr: "Ghardaïa", nameAr: "غرداية" },
  { code: 48, nameFr: "Relizane", nameAr: "غليزان" },
  { code: 49, nameFr: "Timimoun", nameAr: "تيميمون" },
  { code: 50, nameFr: "Bordj Badji Mokhtar", nameAr: "برج باجي مختار" },
  { code: 51, nameFr: "Ouled Djellal", nameAr: "أولاد جلال" },
  { code: 52, nameFr: "Béni Abbès", nameAr: "بني عباس" },
  { code: 53, nameFr: "In Salah", nameAr: "عين صالح" },
  { code: 54, nameFr: "In Guezzam", nameAr: "عين قزام" },
  { code: 55, nameFr: "Touggourt", nameAr: "تقرت" },
  { code: 56, nameFr: "Djanet", nameAr: "جانت" },
  { code: 57, nameFr: "El M'Ghair", nameAr: "المغير" },
  { code: 58, nameFr: "El Meniaa", nameAr: "المنيعة" },
];

const BY_CODE = new Map(WILAYAS.map((w) => [w.code, w]));

export function getWilaya(code: number): Wilaya | undefined {
  return BY_CODE.get(code);
}

export function wilayaName(code: number, locale: string): string {
  const w = BY_CODE.get(code);
  if (!w) return String(code);
  return locale.startsWith("ar") ? w.nameAr : w.nameFr;
}

/** Lower-case ASCII, no diacritics, no separators. "Bordj Bou Arréridj" → "bordjbouarreridj" */
export function normalizeLatin(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Strip tashkeel, unify alef/yaa/taa-marbuta variants, drop the word "ولاية" and spaces. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ولايه/g, "")
    .replace(/\s+/g, "");
}

const LATIN_ALIASES: Record<string, number> = {
  algiers: 16,
  alger: 16,
  algercentre: 16,
  elbahdja: 16,
  bejaia: 6,
  bougie: 6,
  setif: 19,
  tiziouzou: 15,
  bba: 34,
  bordjbouarreridj: 34,
  bordjbouarrerij: 34,
  msila: 28,
  eloued: 39,
  oued: 39,
  aindefla: 44,
  aintemouchent: 46,
  tamanghasset: 11,
  tamenrasset: 11,
  tamanrasset: 11,
  sba: 22,
  sidibelabbes: 22,
  oeb: 4,
  oumelbouaghi: 4,
  soukahras: 41,
  eltarf: 36,
  eltaref: 36,
  taref: 36,
  tipasa: 42,
  tipaza: 42,
  wargla: 30,
  ouargla: 30,
  tougourt: 55,
  touggourt: 55,
  elmenia: 58,
  elmeniaa: 58,
  elgolea: 58,
  elmghair: 57,
  elmeghaier: 57,
  insalah: 53,
  ainsalah: 53,
  inguezzam: 54,
  ainguezzam: 54,
  bbm: 50,
  bordjbadjimokhtar: 50,
  beniabbes: 52,
  ouleddjellal: 51,
  mostaganem: 27,
  bechar: 8,
  medea: 26,
  saida: 20,
  tebessa: 12,
  boumerdes: 35,
  ghardaia: 47,
  naama: 45,
  chlef: 2,
  elasnam: 2,
  laghouat: 3,
  elbayadh: 32,
  relizane: 48,
};

const LATIN_INDEX = new Map<string, number>();
const ARABIC_INDEX = new Map<string, number>();
for (const w of WILAYAS) {
  LATIN_INDEX.set(normalizeLatin(w.nameFr), w.code);
  ARABIC_INDEX.set(normalizeArabic(w.nameAr), w.code);
}
for (const [k, v] of Object.entries(LATIN_ALIASES)) LATIN_INDEX.set(k, v);

/**
 * Resolve a wilaya code from free text: "16", "16 - Alger", "Alger", "ALGER", "الجزائر", "Algiers", "DZ-16".
 * Returns null when unknown. Never guesses.
 */
export function resolveWilayaCode(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return BY_CODE.has(input) ? input : null;
  const raw = input.trim();
  if (!raw) return null;

  const numeric = raw.match(/^(?:dz[-\s]?)?(\d{1,2})(?:\D|$)/i);
  if (numeric) {
    const code = Number(numeric[1]);
    if (BY_CODE.has(code)) return code;
  }

  const latin = normalizeLatin(raw.replace(/^wilaya\s*(de|d')?\s*/i, "").replace(/^\d{1,2}\s*[-–]\s*/, ""));
  if (latin && LATIN_INDEX.has(latin)) return LATIN_INDEX.get(latin) ?? null;

  const arabic = normalizeArabic(raw.replace(/^\d{1,2}\s*[-–]\s*/, ""));
  if (arabic && ARABIC_INDEX.has(arabic)) return ARABIC_INDEX.get(arabic) ?? null;

  // Last resort: a latin name contained in the text (e.g. "Alger Bab Ezzouar")
  for (const [name, code] of LATIN_INDEX) {
    if (name.length >= 5 && latin.startsWith(name)) return code;
  }
  return null;
}
