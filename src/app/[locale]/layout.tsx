import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dirFor, routing } from "@/i18n/routing";
import "../globals.css";

export const metadata: Metadata = {
  title: { default: "COD Center", template: "%s · COD Center" },
  description: "Confirmation, suivi de livraison et stock pour les boutiques e-commerce en Algérie",
};

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  return (
    <html lang={locale} dir={dirFor(locale)} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
