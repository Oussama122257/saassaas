import { defineRouting } from "next-intl/routing";

export const locales = ["fr", "ar"] as const;
export type Locale = (typeof locales)[number];

export const routing = defineRouting({
  locales,
  defaultLocale: "fr",
  localePrefix: "always",
});

export function isLocale(value: string | undefined): value is Locale {
  return value === "fr" || value === "ar";
}

export function dirFor(locale: string): "rtl" | "ltr" {
  return locale.startsWith("ar") ? "rtl" : "ltr";
}
