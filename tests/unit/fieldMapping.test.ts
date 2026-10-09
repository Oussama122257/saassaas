import { describe, expect, it } from "vitest";
import { applyMapping, asAmount, columnLetter, getPath, resolvePath, rowToColumns } from "@/lib/ingest/fieldMapping";
import { mapShopifyOrder, signShopifyWebhook, verifyShopifyWebhook, verifyOAuthQuery } from "@/lib/adapters/stores/shopify";
import { mapDzbuildOrder, signDzbuild, verifyDzbuildSignature, dzbuildStatusFor } from "@/lib/adapters/stores/dzbuild";
import { mapSheetRows, parseSheetRef } from "@/lib/adapters/stores/googleSheets";
import { parseCsv, toCsv } from "@/lib/csv";
import { createHmac } from "node:crypto";

const shopifyOrder = {
  admin_graphql_api_id: "gid://shopify/Order/1001",
  name: "#1001",
  created_at: "2026-10-01T10:00:00Z",
  current_total_price: "7000.00",
  shipping_lines: [{ price: "500.00", title: "Livraison à domicile" }],
  shipping_address: { name: "Amine Benali", phone: "+213 550 12 34 56", province: "XL", city: "Bab Ezzouar", address1: "Cité 5" },
  note_attributes: [{ name: "Wilaya", value: "16 - Alger" }, { name: "Commune", value: "Bab Ezzouar" }],
  line_items: [{ sku: "ABY-M", title: "Abaya", variant_title: "M", quantity: 1, price: "6500.00" }],
};

describe("field mapping (sections 12.5, 19c.5)", () => {
  it("resolves dot paths, indexes, [key=value] filters, alternatives and literals", () => {
    expect(getPath(shopifyOrder, "line_items[0].sku")).toBe("ABY-M");
    expect(getPath(shopifyOrder, "note_attributes[name=wilaya].value")).toBe("16 - Alger");
    expect(resolvePath(shopifyOrder, "missing.path | shipping_address.city")).toBe("Bab Ezzouar");
    expect(resolvePath(shopifyOrder, '="STOP_DESK"')).toBe("STOP_DESK");
    expect(asAmount("1 500,00 DA")).toBe(1500);
    expect(asAmount("7000.00")).toBe(7000);
  });

  it("maps a Shopify webhook order and lets a store override the wilaya source (COD form apps)", () => {
    const def = mapShopifyOrder(shopifyOrder);
    expect(def).toMatchObject({ externalId: "gid://shopify/Order/1001", externalName: "#1001", customerName: "Amine Benali", wilaya: "XL", total: 7000, shippingFee: 500 });
    expect(def.items).toEqual([{ sku: "ABY-M", name: "Abaya", variant: "M", qty: 1, unitPrice: 6500 }]);
    const overridden = mapShopifyOrder(shopifyOrder, { wilaya: "note_attributes[name=Wilaya].value" });
    expect(overridden.wilaya).toBe("16 - Alger");
  });

  it("maps DZBuild payloads wrapped in {data}", () => {
    const m = mapDzbuildOrder({ event: "order.created", data: { id: "dz-9", customer: { name: "Sarah", phone: "0660000000" }, wilaya: "Oran", items: [{ name: "Hachoir", quantity: 2, price: 2900 }], total: 6400 } });
    expect(m).toMatchObject({ externalId: "dz-9", customerName: "Sarah", phone: "0660000000", wilaya: "Oran", total: 6400 });
    expect(m.items[0]).toMatchObject({ name: "Hachoir", qty: 2, unitPrice: 2900 });
    expect(dzbuildStatusFor("CONFIRMEE_BOT")).toBe("confirmed");
    expect(dzbuildStatusFor("DOUBLE")).toBe("cancel");
    expect(dzbuildStatusFor("APPEL_1")).toBeNull();
  });

  it("maps Google Sheet rows by column letter, after the last processed row", () => {
    const rows = parseCsv("date,name,phone,wilaya,commune,address,product,variant,qty,total\n2026-10-01,Amine,0550123456,Alger,Kouba,Cité 1,Abaya,M,1,7000\n2026-10-01,Lina,0660123456,Oran,Es Senia,Rue 2,Abaya,L,2,13500\n");
    const mapped = mapSheetRows(rows, null, 2);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ rowNumber: 3, mapped: { externalId: "row-3", customerName: "Lina", wilaya: "Oran", total: 13500 } });
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(27)).toBe("AB");
    expect(rowToColumns(["x", "y"]).columns).toEqual({ A: "x", B: "y" });
    expect(parseSheetRef("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42")).toEqual({ sheetId: "abc_123", gid: "42" });
  });
});

describe("webhook signatures", () => {
  it("Shopify HMAC: valid passes, tampered body or header fails", () => {
    const body = JSON.stringify(shopifyOrder);
    const sig = signShopifyWebhook(body, "s3cret");
    expect(verifyShopifyWebhook(body, sig, "s3cret")).toBe(true);
    expect(verifyShopifyWebhook(body + " ", sig, "s3cret")).toBe(false);
    expect(verifyShopifyWebhook(body, "AAAA", "s3cret")).toBe(false);
    expect(verifyShopifyWebhook(body, null, "s3cret")).toBe(false);
  });

  it("Shopify OAuth query HMAC", () => {
    const q = new URLSearchParams({ code: "abc", shop: "demo.myshopify.com", state: "xyz", timestamp: "1700000000" });
    const message = [...q.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    q.set("hmac", createHmac("sha256", "s3cret").update(message).digest("hex"));
    expect(verifyOAuthQuery(q, "s3cret")).toBe(true);
    q.set("code", "tampered");
    expect(verifyOAuthQuery(q, "s3cret")).toBe(false);
  });

  it("DZBuild X-DZ-Signature: valid, stale (> 5 min) and bad signatures", () => {
    const body = '{"event":"order.created"}';
    const t = 1_800_000_000;
    const header = signDzbuild(body, "whsec", t);
    expect(verifyDzbuildSignature(body, header, "whsec", t + 10)).toEqual({ ok: true });
    expect(verifyDzbuildSignature(body, header, "whsec", t + 301)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(verifyDzbuildSignature(body, header, "other", t)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyDzbuildSignature(body, null, "whsec", t)).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("csv", () => {
  it("round-trips quotes, separators and newlines, and neutralizes formulas", () => {
    const csv = toCsv([["a", 'b "q"', "c,d"], ["=SUM(A1)", "line\nbreak", 12]]);
    const back = parseCsv(csv);
    expect(back[0]).toEqual(["a", 'b "q"', "c,d"]);
    expect(back[1]).toEqual(["'=SUM(A1)", "line\nbreak", "12"]);
    expect(parseCsv("x;y\n1;2")).toEqual([["x", "y"], ["1", "2"]]);
  });

  it("applies a whole mapping", () => {
    const m = applyMapping({ a: { phone: "0550" }, items: [{ n: "P", q: "2" }] }, { phone: "a.phone", items: "items", itemName: "n", itemQty: "q" });
    expect(m.phone).toBe("0550");
    expect(m.items).toEqual([{ sku: null, name: "P", variant: null, qty: 2, unitPrice: null }]);
  });
});
