import type { Page } from "@playwright/test";

export async function login(page: Page, email: string, locale = "fr", password = "password123") {
  await page.goto(`/${locale}/login`);
  await page.getByLabel(locale === "ar" ? "البريد الإلكتروني" : "E-mail").fill(email);
  await page.getByLabel(locale === "ar" ? "كلمة المرور" : "Mot de passe").fill(password);
  await page.getByTestId("login-form").getByRole("button").click();
  await page.waitForURL(new RegExp(`/${locale}/dashboard`));
}
