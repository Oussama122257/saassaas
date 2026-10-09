import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePageRole } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { storeCredentials, storeSettings } from "@/lib/stores/service";
import { SHOPIFY_DEFAULT_MAPPING } from "@/lib/adapters/stores/shopify";
import { DZBUILD_DEFAULT_MAPPING } from "@/lib/adapters/stores/dzbuild";
import { SHEET_DEFAULT_MAPPING } from "@/lib/adapters/stores/googleSheets";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StoreConnect } from "@/components/settings/store-connect";
import { FieldMappingEditor } from "@/components/settings/field-mapping-editor";
import { StoreOptions } from "@/components/settings/store-options";

export default async function StoreDetailPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ connected?: string }> }) {
  const { locale, id } = await params;
  const { connected } = await searchParams;
  const ctx = await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("stores");
  const store = await prisma.store.findFirst({ where: { id, merchantId: { in: ctx.accessibleMerchantIds } }, include: { merchant: { select: { name: true } } } });
  if (!store) notFound();
  const settings = storeSettings(store);
  const creds = storeCredentials<{ shop?: string; accessToken?: string; apiKey?: string }>(store);
  const defaults = store.channel === "SHOPIFY" ? SHOPIFY_DEFAULT_MAPPING : store.channel === "GOOGLE_SHEET" ? SHEET_DEFAULT_MAPPING : DZBUILD_DEFAULT_MAPPING;
  return (
    <div className="space-y-4">
      <PageHeader
        title={store.name}
        description={`${store.merchant.name} · ${store.channel} · ${t("lastSync")}: ${formatDateTime(store.lastSyncAt, locale, ctx.timezone)}`}
        actions={<Badge variant={store.connection === "CONNECTED" ? "secondary" : "destructive"}>{t(`state.${store.connection}` as "state.CONNECTED")}</Badge>}
      />
      {connected ? <Alert><AlertDescription>{t("connectedNotice")}</AlertDescription></Alert> : null}
      {store.lastError ? <Alert variant="destructive"><AlertDescription>{store.lastError}</AlertDescription></Alert> : null}
      <StoreConnect
        store={{ id: store.id, channel: store.channel, externalRef: store.externalRef, hasToken: !!creds?.accessToken || (store.channel === "DZBUILD" && !!creds?.apiKey), sheetConnected: !!settings.sheet?.sheetId, hasIntakeToken: !!settings.intakeToken }}
        appUrl={process.env.APP_URL ?? ""}
      />
      <FieldMappingEditor storeId={store.id} channel={store.channel} defaults={defaults as Record<string, string>} current={(store.fieldMapping ?? {}) as Record<string, string>} />
      <StoreOptions storeId={store.id} channel={store.channel} writeBack={settings.writeBack ?? {}} backfillDays={settings.backfillDays ?? 7} active={store.active} />
    </div>
  );
}
