import { describe, expect, it } from "vitest";
import { WILAYAS, resolveWilayaCode, wilayaName } from "@/lib/wilayas";

describe("wilayas", () => {
  it("has the 58 wilayas with unique codes", () => {
    expect(WILAYAS).toHaveLength(58);
    expect(new Set(WILAYAS.map((w) => w.code)).size).toBe(58);
    expect(WILAYAS[57]).toEqual({ code: 58, nameFr: "El Meniaa", nameAr: "المنيعة" });
  });
  it("resolves French, Arabic, numeric and alias inputs", () => {
    expect(resolveWilayaCode("Alger")).toBe(16);
    expect(resolveWilayaCode("ALGER")).toBe(16);
    expect(resolveWilayaCode("Algiers")).toBe(16);
    expect(resolveWilayaCode("الجزائر")).toBe(16);
    expect(resolveWilayaCode("ولاية الجزائر")).toBe(16);
    expect(resolveWilayaCode("16")).toBe(16);
    expect(resolveWilayaCode("16 - Alger")).toBe(16);
    expect(resolveWilayaCode(31)).toBe(31);
    expect(resolveWilayaCode("Bordj Bou Arreridj")).toBe(34);
    expect(resolveWilayaCode("BBA")).toBe(34);
    expect(resolveWilayaCode("Tizi-Ouzou")).toBe(15);
    expect(resolveWilayaCode("Sétif")).toBe(19);
    expect(resolveWilayaCode("setif")).toBe(19);
    expect(resolveWilayaCode("M'Sila")).toBe(28);
    expect(resolveWilayaCode("وهران")).toBe(31);
    expect(resolveWilayaCode("Ain Temouchent")).toBe(46);
    expect(resolveWilayaCode("El M'Ghair")).toBe(57);
  });
  it("never guesses", () => {
    expect(resolveWilayaCode("Paris")).toBeNull();
    expect(resolveWilayaCode("99")).toBeNull();
    expect(resolveWilayaCode("")).toBeNull();
    expect(resolveWilayaCode(undefined)).toBeNull();
  });
  it("names follow the locale", () => {
    expect(wilayaName(31, "fr")).toBe("Oran");
    expect(wilayaName(31, "ar")).toBe("وهران");
  });
});
