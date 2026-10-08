import { describe, expect, it } from "vitest";
import { formatPhone, maskPhone, normalizePhone, toAsciiDigits } from "@/lib/phone";

describe("normalizePhone", () => {
  it("accepts the common Algerian formats", () => {
    for (const raw of ["0550123456", "05 50 12 34 56", "+213550123456", "00213 550 12 34 56", "213550123456", "550123456", "٠٥٥٠١٢٣٤٥٦", "0550-12-34-56"]) {
      expect(normalizePhone(raw)).toEqual({ phone: "0550123456", valid: true, type: "MOBILE" });
    }
    expect(normalizePhone("0661234567").type).toBe("MOBILE");
    expect(normalizePhone("0770000000").type).toBe("MOBILE");
  });
  it("recognizes landlines and rejects garbage", () => {
    expect(normalizePhone("021234567")).toEqual({ phone: "021234567", valid: true, type: "LANDLINE" });
    expect(normalizePhone("0812345678").valid).toBe(false);
    expect(normalizePhone("12345").valid).toBe(false);
    expect(normalizePhone("").valid).toBe(false);
    expect(normalizePhone(null).phone).toBeNull();
  });
  it("converts Arabic-Indic digits", () => {
    expect(toAsciiDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(toAsciiDigits("۰۱۲")).toBe("012");
  });
  it("masks and formats for display", () => {
    expect(maskPhone("0550123456")).toBe("05******56");
    expect(formatPhone("0550123456")).toBe("0550 12 34 56");
  });
});
