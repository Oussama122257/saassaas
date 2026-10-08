import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { API_SCOPES } from "@/lib/api/keys";
import { PageHeader } from "@/components/page-header";
import { ApiKeysClient } from "./api-keys-client";

export default async function ApiKeysPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const ctx = await requirePageRole(locale, ["ORG_OWNER"]);
  const t = await getTranslations("settings.apiKeys");
  const keys = await prisma.apiKey.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
    select: { keyId: true, name: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <ApiKeysClient
        locale={locale}
        timezone={ctx.timezone}
        scopes={[...API_SCOPES]}
        keys={keys.map((k) => ({ ...k, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null }))}
      />
    </div>
  );
}
