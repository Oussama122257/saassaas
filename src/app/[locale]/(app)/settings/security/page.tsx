import { getTranslations } from "next-intl/server";
import { requireContext } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import { TotpSetup } from "./totp-setup";

export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requireContext(locale);
  const t = await getTranslations("settings.security");
  const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { totpEnabledAt: true } });
  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <TotpSetup enabled={Boolean(user?.totpEnabledAt)} />
    </div>
  );
}
