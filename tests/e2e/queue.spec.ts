import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe("phase 2 — agent queue and call screen", () => {
  test("an agent gets one order at a time from the queue (or a blocked-window notice)", async ({ page }) => {
    await login(page, "agent1a@demo.local");
    await page.goto("/fr/queue");
    await expect(page.getByTestId("queue-stats")).toBeVisible();
    await page.getByTestId("next-order").click();
    // depending on the time of day calls may be blocked (before 09:00, after 21:00, prayer, Friday midday)
    const screen = page.getByTestId("call-screen");
    const notice = page.getByRole("alert");
    await expect(screen.or(notice).first()).toBeVisible({ timeout: 15_000 });
    if (await screen.isVisible()) {
      await expect(page.getByTestId("total-to-pay")).toBeVisible();
      await expect(page.getByTestId("checklist")).toBeVisible();
      await expect(page.getByTestId("attempt-timeline")).toBeVisible();
      // confirm stays disabled until the checklist is complete
      await expect(page.getByTestId("confirm")).toBeDisabled();
    }
  });

  test("a supervisor can open the manual order form, stores and operations settings", async ({ page }) => {
    await login(page, "supervisor@demo.local");
    await page.goto("/fr/orders/new");
    await expect(page.getByTestId("manual-order-form")).toBeVisible();
    await page.goto("/fr/settings/stores");
    await expect(page.getByText("Store A — Shopify")).toBeVisible();
    await page.goto("/fr/settings/operations");
    await expect(page.getByText("Cadence d'appel (3 × 3)")).toBeVisible();
    await page.goto("/fr/team");
    await expect(page.getByTestId("team-table")).toBeVisible();
  });

  test("the orders list shows the attempt count next to the status", async ({ page }) => {
    await login(page, "supervisor@demo.local");
    await page.goto("/fr/orders?status=APPEL_2");
    await expect(page.getByTestId("attempt-count").first()).toContainText("2");
  });
});
