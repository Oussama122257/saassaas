import { describe, expect, it, beforeAll } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, totp, verifyTotp } from "@/lib/auth/totp";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 appendix B test vector: secret "12345678901234567890", T=59 → 94287082 (8 digits)
  const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  it("round-trips base32", () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(secret).toString("ascii")).toBe("12345678901234567890");
  });
  it("matches the RFC vectors", () => {
    expect(hotp(secret, 1)).toBe("287082");
    expect(totp(secret, new Date(59 * 1000))).toBe("287082");
    expect(totp(secret, new Date(1111111109 * 1000))).toBe("081804");
    expect(totp(secret, new Date(1234567890 * 1000))).toBe("005924");
  });
  it("verifies with a ±1 step window and rejects garbage", () => {
    const at = new Date(1111111109 * 1000);
    expect(verifyTotp(secret, "081804", at)).toBe(true);
    expect(verifyTotp(secret, "081 804", at)).toBe(true);
    expect(verifyTotp(secret, "081804", new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(secret, "081804", new Date(at.getTime() + 120_000))).toBe(false);
    expect(verifyTotp(secret, "12345", at)).toBe(false);
    expect(verifyTotp(secret, "abcdef", at)).toBe(false);
  });
  it("generates secrets and otpauth URLs", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl({ issuer: "COD Center", account: "a@b.c", secret: s })).toBe(`otpauth://totp/COD%20Center%3Aa%40b.c?secret=${s}&issuer=COD%20Center&algorithm=SHA1&digits=6&period=30`);
  });
});

describe("passwords (scrypt)", () => {
  it("hashes and verifies", () => {
    const h = hashPassword("password123");
    expect(h.startsWith("scrypt$16384$")).toBe(true);
    expect(verifyPassword("password123", h)).toBe(true);
    expect(verifyPassword("Password123", h)).toBe(false);
    expect(verifyPassword("password123", null)).toBe(false);
    expect(verifyPassword("password123", "garbage")).toBe(false);
  });
});

describe("secrets at rest", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "5GmrGO6Hqz6KpQ9m0e1wP2tY4uI7oA9sD1fG3hJ5kL8=";
  });
  it("encrypts and decrypts JSON credentials", async () => {
    const { decryptJson, encryptJson, decryptSecret, encryptSecret } = await import("@/lib/crypto");
    const payload = { apiId: "123", token: "secret-token" };
    const enc = encryptJson(payload);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("secret-token");
    expect(decryptJson(enc)).toEqual(payload);
    expect(encryptSecret("x")).not.toBe(encryptSecret("x")); // random IV
    const [v, b64] = enc.split(":");
    const bytes = Buffer.from(b64!, "base64");
    bytes[30] = (bytes[30]! + 1) & 0xff; // flip a ciphertext byte → GCM auth tag fails
    expect(() => decryptSecret(`${v}:${bytes.toString("base64")}`)).toThrow();
  });
});
