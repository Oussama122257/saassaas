import { redirect } from "next/navigation";
import { getCurrentContext } from "@/lib/auth/session";

export default async function LocaleIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await getCurrentContext();
  redirect(ctx ? `/${locale}/dashboard` : `/${locale}/login`);
}
