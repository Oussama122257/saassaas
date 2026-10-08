import type { ReactNode } from "react";
import { requireContext } from "@/lib/auth/guards";
import { AppShell } from "@/components/layout/app-shell";

export default async function AppLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requireContext(locale);
  return (
    <AppShell ctx={ctx} locale={locale}>
      {children}
    </AppShell>
  );
}
