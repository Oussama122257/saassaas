import { randomBytes } from "node:crypto";
import { prisma, withSystemContext } from "@/lib/db";

/**
 * Public tracking page (section 19b.5): /{locale}/t/{token}, and short links /s/{code} for SMS.
 */
export function publicBaseUrl(): string {
  return (process.env.PUBLIC_TRACKING_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

export async function ensureTrackingToken(orderId: string): Promise<string> {
  return withSystemContext("tracking-token", async () => {
    const order = await prisma.order.findFirst({ where: { id: orderId }, select: { trackingToken: true, merchantId: true } });
    if (!order) throw new Error("order not found");
    if (order.trackingToken) return order.trackingToken;
    const token = randomBytes(12).toString("base64url");
    await prisma.order.update({ where: { id: orderId, merchantId: order.merchantId }, data: { trackingToken: token } });
    return token;
  });
}

export function trackingUrl(token: string, lang: "fr" | "ar"): string {
  return `${publicBaseUrl()}/${lang}/t/${token}`;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function shortLink(url: string, orderId?: string): Promise<string> {
  const existing = await prisma.shortLink.findFirst({ where: { url } });
  if (existing) return `${publicBaseUrl()}/s/${existing.code}`;
  for (let i = 0; i < 5; i++) {
    const bytes = randomBytes(7);
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    try {
      await prisma.shortLink.create({ data: { code, url, orderId } });
      return `${publicBaseUrl()}/s/${code}`;
    } catch {
      /* collision: retry */
    }
  }
  return url;
}
