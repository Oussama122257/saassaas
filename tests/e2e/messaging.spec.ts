import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("phase 3 — messaging, devices, tracking", () => {
  test("the public tracking page works without login, in FR and AR (RTL)", async ({ page }) => {
    await page.goto("/fr/t/demo-tracking-0001");
    await expect(page.getByTestId("tracking-page")).toBeVisible();
    await expect(page.getByTestId("tracking-status")).toHaveText("Sorti en livraison");
    await page.goto("/ar/t/demo-tracking-0001");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("tracking-status")).toHaveText("عند الموزع");
  });

  test("a supervisor sees messaging credits and templates", async ({ page }) => {
    await login(page, "supervisor@demo.local");
    await page.goto("/fr/settings/messaging");
    await expect(page.getByTestId("credit-balance")).toContainText("1000");
  });

  test("an agent pairs an Android phone and gets the one-time configuration", async ({ page }) => {
    await login(page, "agent1b@demo.local");
    await page.goto("/fr/devices");
    await page.getByRole("button", { name: "Appairer un téléphone" }).click();
    await expect(page.getByTestId("device-config")).toContainText("deviceToken");
  });
});
