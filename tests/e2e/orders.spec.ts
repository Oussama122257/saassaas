import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("orders (seeded data)", () => {
  test("supervisor sees orders, chips, filters and bulk actions; status labels follow the locale", async ({ page }) => {
    await login(page, "supervisor@demo.local");
    await page.goto("/fr/orders");
    await expect(page.getByTestId("queue-chips")).toBeVisible();
    await expect(page.getByTestId("order-filters")).toBeVisible();
    await expect(page.getByTestId("bulk-bar")).toBeVisible();
    const rows = page.getByTestId("order-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(10);

    await page.goto("/fr/orders?status=CONFIRMEE");
    await expect(page.locator("[data-testid='order-row'] [data-status='CONFIRMEE']").first()).toHaveText("Confirmée");

    // AR: same page, RTL, Arabic label from the dictionary (the mobile switcher is hidden on desktop)
    await page.getByTestId("locale-switcher").filter({ visible: true }).first().click();
    await page.waitForURL(/\/ar\/orders/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("[data-testid='order-row'] [data-status='CONFIRMEE']").first()).toHaveText("مؤكدة");
  });

  test("chip filter narrows the table and the order detail opens with the status dialog", async ({ page }) => {
    await login(page, "supervisor@demo.local");
    await page.goto("/fr/orders?chip=NOT_TREATED");
    const rows = page.getByTestId("order-row");
    await expect(rows.first()).toBeVisible();
    const statuses = await page.locator("[data-testid='order-row'] [data-status]").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    expect(statuses.every((s) => s === "NOUVEAU" || s === "ASSIGNEE")).toBe(true);

    await rows.first().getByRole("link", { name: /^#\d+$/ }).click();
    await page.waitForURL(/\/fr\/orders\/[a-z0-9]+/);
    await expect(page.getByTestId("order-total")).toBeVisible();
    await expect(page.getByTestId("timeline")).toBeVisible();
    await page.getByTestId("change-status").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("search by phone finds the order", async ({ page }) => {
    await login(page, "supervisor@demo.local");
    await page.goto("/fr/orders?pageSize=20");
    const phone = (await page.getByTestId("order-row").first().locator("[dir='ltr']").first().textContent())?.trim();
    expect(phone).toMatch(/^0\d{9}$/);
    await page.goto(`/fr/orders?q=${phone}`);
    const rows = page.getByTestId("order-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    await expect(rows.first().locator("[dir='ltr']").first()).toHaveText(phone!);
  });
});

test.describe("role scoping", () => {
  test("a confirmation agent only sees their own orders and has no bulk bar or audit menu", async ({ page }) => {
    await login(page, "agent1a@demo.local", "ar");
    await page.goto("/ar/orders");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
    await expect(page.getByTestId("sidebar").getByRole("link", { name: "سجل التدقيق" })).toHaveCount(0);
    const agents = await page.locator("[data-testid='order-row'] td:nth-last-child(4)").allTextContents();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((a) => a.trim() === "Amine Agent")).toBe(true);
  });

  test("a client viewer is read-only and cannot open settings", async ({ page }) => {
    await login(page, "client-a@demo.local");
    await page.goto("/fr/orders");
    await expect(page.getByTestId("order-row").first()).toBeVisible();
    await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
    await page.goto("/fr/settings");
    await page.waitForURL(/\/fr\/dashboard\?forbidden=1/);
  });

  test("wrong password shows an error", async ({ page }) => {
    await page.goto("/fr/login");
    await page.getByLabel("E-mail").fill("supervisor@demo.local");
    await page.getByLabel("Mot de passe").fill("nope");
    await page.getByTestId("login-form").getByRole("button").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });
});

test.describe("public API", () => {
  test("ping, whoami and orders with the seeded demo key", async ({ request }) => {
    const ping = await request.get("/api/v1/ping", { headers: { "X-Request-Id": "e2e-1" } });
    expect(ping.status()).toBe(200);
    expect(ping.headers()["x-request-id"]).toBe("e2e-1");
    const anon = await request.get("/api/v1/whoami");
    expect(anon.status()).toBe(401);
    const auth = { Authorization: "Bearer ck_demo_agency.demo-secret-agency-hq-change-me" };
    const who = await request.get("/api/v1/whoami", { headers: auth });
    expect((await who.json()).data.org.name).toBe("Agency HQ");
    const orders = await request.get("/api/v1/orders?limit=5&status=LIVRE", { headers: auth });
    const body = await orders.json();
    expect(body.data).toHaveLength(5);
    expect(body.data.every((o: { status: string }) => o.status === "LIVRE")).toBe(true);
    expect(body.meta.next_cursor).toBeTruthy();
    const post = await request.post("/api/v1/orders", { headers: auth, data: {} });
    expect([400, 405]).toContain(post.status());
  });
});
