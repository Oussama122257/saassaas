import { getTranslations } from "next-intl/server";
import { KeyRound, ShieldCheck, Tags } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { requirePageRole } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageRole(locale, ["ORG_OWNER", "SUPERVISOR"]);
  const t = await getTranslations("settings");
  const items = [
    { href: "/settings/api-keys", title: t("apiKeys.title"), description: t("apiKeys.description"), icon: KeyRound },
    { href: "/settings/security", title: t("security.title"), description: t("security.description"), icon: ShieldCheck },
    { href: "/settings/statuses", title: t("statuses.title"), description: t("statuses.description"), icon: Tags },
  ];
  return (
    <div>
      <PageHeader title={t("title")} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <Link key={i.href} href={i.href}>
            <Card className="h-full transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-center gap-2">
                <i.icon className="size-5 text-muted-foreground" aria-hidden />
                <CardTitle className="text-base">{i.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{i.description}</CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
