import { describe, expect, it } from "vitest";
import { detectFakeSignals, findWilayaInText, looksLikeVariantText, validateAddress } from "@/lib/intake/validate";

const communes = [
  { wilayaCode: 16, nameFr: "Bab Ezzouar", nameAr: "باب الزوار" },
  { wilayaCode: 31, nameFr: "Bir El Djir", nameAr: "بئر الجير" },
];

describe("intake validation (section 19c.4)", () => {
  it("detects size / colour text", () => {
    for (const t of ["XL", "M", "Taille 42", "Noir", "أسود", "مقاس L", "120"]) expect(looksLikeVariantText(t), t).toBe(true);
    for (const t of ["Alger", "16", "Oran", "باب الزوار"]) expect(looksLikeVariantText(t), t).toBe(false);
  });

  it("flags size text in the wilaya field as ADDRESS_MAPPING", () => {
    const r = validateAddress({ wilaya: "XL", commune: "Kouba", address: "Cité 5" }, communes);
    expect(r.wilayaCode).toBeNull();
    expect(r.errors).toContain("ADDRESS_MAPPING");
  });

  it("auto-repairs when the wilaya is found in another field", () => {
    const r = validateAddress({ wilaya: "Noir", commune: "Bab Ezzouar", address: "Alger, Cité 5" }, communes);
    expect(r).toMatchObject({ wilayaCode: 16, repaired: true });
    expect(r.errors).toEqual([]);
    const fromCommune = validateAddress({ wilaya: "", commune: "Bir El Djir", address: "Rue 1" }, communes);
    expect(fromCommune).toMatchObject({ wilayaCode: 31, repaired: true });
  });

  it("detects a commune that belongs to another wilaya and swapped fields", () => {
    expect(validateAddress({ wilaya: 16, commune: "Bir El Djir", address: "x" }, communes).errors).toContain("COMMUNE_WILAYA_MISMATCH");
    expect(validateAddress({ wilaya: 16, commune: "Oran", address: "x" }, communes).errors).toContain("ADDRESS_MAPPING");
    expect(validateAddress({ wilaya: 16, commune: "Bab Ezzouar", address: "x" }, communes).errors).toEqual([]);
  });

  it("requires an address for home delivery only", () => {
    expect(validateAddress({ wilaya: 16, address: " " }, communes).errors).toContain("ADDRESS_EMPTY");
    expect(validateAddress({ wilaya: 16, deliveryType: "STOP_DESK" }, communes).errors).toEqual([]);
  });

  it("finds wilaya names inside free text (FR and AR)", () => {
    expect(findWilayaInText("Cité 20 août, Constantine centre")).toBe(25);
    expect(findWilayaInText("حي 500 مسكن وهران")).toBe(31);
    expect(findWilayaInText("Rue sans nom")).toBeNull();
  });

  it("detects obvious fakes", () => {
    expect(detectFakeSignals({ name: "Amine Benali", phone: "0550123456" })).toEqual([]);
    expect(detectFakeSignals({ name: "test", phone: "0550123456" })).toContain("TEST_ORDER");
    expect(detectFakeSignals({ name: "Amine", phone: "12345" })).toContain("INVALID_PHONE");
    expect(detectFakeSignals({ name: "Amine", phone: "0555555555" })).toContain("INVALID_PHONE");
    expect(detectFakeSignals({ name: "xkcdqwrt", phone: "0550123456" })).toContain("NAME_NONSENSE");
    expect(detectFakeSignals({ name: "aaaa", phone: "0550123456" })).toContain("NAME_NONSENSE");
  });
});
