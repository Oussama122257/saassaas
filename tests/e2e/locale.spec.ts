import { expect, test } from "@playwright/test";

test.describe("FR ⇄ AR with correct direction", () => {
  test("login page switches language and direction", async ({ page }) => {
    await page.goto("/fr/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByText("Connexion", { exact: true })).toBeVisible();

    await page.getByTestId("locale-switcher").click();
    await page.waitForURL(/\/ar\/login/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByText("تسجيل الدخول", { exact: true })).toBeVisible();

    await page.getByTestId("locale-switcher").click();
    await page.waitForURL(/\/fr\/login/);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });

  test("unknown locale prefix is a 404", async ({ page }) => {
    const res = await page.goto("/de/login");
    expect(res?.status()).toBe(404);
  });
});
