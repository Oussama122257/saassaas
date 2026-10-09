import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCurrentContext } from "@/lib/auth/session";
import { buildInstallUrl, isValidShopDomain } from "@/lib/adapters/stores/shopify";
import { randomToken } from "@/lib/crypto";
import { requireStoreAdmin } from "@/lib/stores/access";
import { storeCredentials } from "@/lib/stores/service";

/**
 * Start the OAuth install of the store's Shopify custom app (section 12.5, v1: one custom app per
 * store, custom distribution). The app's client id/secret are saved on the store first (connect
 * screen); SHOPIFY_API_KEY/SECRET are the fallback for a single shared app.
 */
export async function GET(req: NextRequest) {
  const ctx = await getCurrentContext();
  if (!ctx) return NextResponse.redirect(new URL("/fr/login", req.url));
  const url = new URL(req.url);
  const storeId = url.searchParams.get("storeId") ?? "";
  const shop = (url.searchParams.get("shop") ?? "").trim().toLowerCase();
  if (!isValidShopDomain(shop)) return NextResponse.json({ error: "invalid_shop", message: "Use the *.myshopify.com domain" }, { status: 400 });
  const store = await requireStoreAdmin(ctx, storeId).catch(() => null);
  if (!store || store.channel !== "SHOPIFY") return NextResponse.json({ error: "store_not_found" }, { status: 404 });
  const app = storeCredentials<{ apiKey?: string }>(store);
  const apiKey = app?.apiKey ?? process.env.SHOPIFY_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "missing_app_credentials" }, { status: 400 });

  const state = randomToken(16);
  const jar = await cookies();
  jar.set("shopify_oauth", JSON.stringify({ state, storeId, shop }), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  const appUrl = process.env.APP_URL ?? url.origin;
  return NextResponse.redirect(
    buildInstallUrl({ shop, apiKey, scopes: process.env.SHOPIFY_SCOPES ?? "read_orders,write_orders,read_products", redirectUri: `${appUrl}/api/integrations/shopify/callback`, state }),
  );
}
