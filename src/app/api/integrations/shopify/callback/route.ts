import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { encryptJson, encryptSecret, safeEqual } from "@/lib/crypto";
import { exchangeOAuthCode, isValidShopDomain, verifyOAuthQuery } from "@/lib/adapters/stores/shopify";
import { requireStoreAdmin } from "@/lib/stores/access";
import { storeCredentials } from "@/lib/stores/service";
import { enqueue } from "@/lib/queue";
import { writeAuditLog } from "@/lib/audit";

/** OAuth callback: verify state + HMAC, exchange the code, store the offline token encrypted, then backfill. */
export async function GET(req: NextRequest) {
  const ctx = await getCurrentContext();
  const url = new URL(req.url);
  const jar = await cookies();
  const raw = jar.get("shopify_oauth")?.value;
  jar.delete("shopify_oauth");
  if (!ctx || !raw) return NextResponse.json({ error: "session_expired" }, { status: 401 });
  const saved = JSON.parse(raw) as { state: string; storeId: string; shop: string };
  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!safeEqual(state, saved.state) || shop !== saved.shop || !isValidShopDomain(shop)) return NextResponse.json({ error: "invalid_state" }, { status: 400 });

  const store = await requireStoreAdmin(ctx, saved.storeId).catch(() => null);
  if (!store) return NextResponse.json({ error: "store_not_found" }, { status: 404 });
  const app = storeCredentials<{ apiKey?: string; apiSecret?: string }>(store);
  const apiKey = app?.apiKey ?? process.env.SHOPIFY_API_KEY ?? "";
  const apiSecret = app?.apiSecret ?? process.env.SHOPIFY_API_SECRET ?? "";
  if (!verifyOAuthQuery(url.searchParams, apiSecret)) return NextResponse.json({ error: "invalid_hmac" }, { status: 400 });

  const token = await exchangeOAuthCode({ shop, apiKey, apiSecret, code });
  await prisma.store.update({
    where: { id: store.id, merchantId: store.merchantId },
    data: {
      externalRef: shop,
      credentials: encryptJson({ shop, accessToken: token.accessToken, scope: token.scope, apiKey, apiSecret }),
      webhookSecret: encryptSecret(apiSecret),
      connection: "CONNECTED",
      lastError: null,
    },
  });
  await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Store", targetId: store.id, payload: { shopify: shop, scope: token.scope } });
  await enqueue("store.backfill", { storeId: store.id });
  const locale = ctx.locale.startsWith("ar") ? "ar" : "fr";
  return NextResponse.redirect(new URL(`/${locale}/settings/stores/${store.id}?connected=1`, process.env.APP_URL ?? url.origin));
}
