import type { Store } from "@prisma/client";
import { decryptSecret, encryptSecret, randomToken } from "@/lib/crypto";

/** Store.webhookSecret is encrypted at rest ("v1:…"); legacy plain values are still accepted. */
export function readWebhookSecret(store: Pick<Store, "webhookSecret">): string | null {
  if (!store.webhookSecret) return null;
  if (!store.webhookSecret.startsWith("v1:")) return store.webhookSecret;
  try {
    return decryptSecret(store.webhookSecret);
  } catch {
    return null;
  }
}

export function newWebhookSecret(): { plain: string; stored: string } {
  const plain = randomToken(32);
  return { plain, stored: encryptSecret(plain) };
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}
