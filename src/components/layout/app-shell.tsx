import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { ClipboardList, LayoutDashboard, ScrollText, Settings, LogOut, PhoneCall, Users, PackageX, Smartphone } from "lucide-react";
import { prisma } from "@/lib/db";
import { AvailabilityToggle } from "./availability-toggle";
import { Link } from "@/i18n/navigation";
import type { TenantContext } from "@/lib/tenant";
import { SUPERVISOR_PLUS, hasRole } from "@/lib/tenant";
import { logoutAction } from "@/lib/auth/actions";
import { LocaleSwitcher } from "./locale-switcher";
import { OrgSwitcher } from "./org-switcher";
import { NavLink } from "./nav-link";

export async function AppShell({ ctx, locale, children }: { ctx: TenantContext; locale: string; children: ReactNode }) {
  const t = await getTranslations("nav");
  const tc = await getTranslations("common");
  const tr = await getTranslations("roles");

  const items = [
    { href: "/dashboard", label: t("dashboard"), icon: LayoutDashboard, show: true },
    { href: "/queue", label: t("queue"), icon: PhoneCall, show: hasRole(ctx, ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT"]) && !ctx.isPlatformAdmin },
    { href: "/orders", label: t("orders"), icon: ClipboardList, show: true },
    { href: "/team", label: t("team"), icon: Users, show: hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"]) },
    { href: "/devices", label: t("devices"), icon: Smartphone, show: hasRole(ctx, ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR", "ORG_OWNER"]) },
    { href: "/unmatched", label: t("unmatched"), icon: PackageX, show: hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"]) },
    { href: "/audit", label: t("audit"), icon: ScrollText, show: hasRole(ctx, SUPERVISOR_PLUS) },
    { href: "/settings", label: t("settings"), icon: Settings, show: hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"]) },
  ].filter((i) => i.show);
  const isAgent = ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT"].includes(ctx.role);
  const membership = isAgent ? await prisma.membership.findUnique({ where: { userId_orgId: { userId: ctx.userId, orgId: ctx.orgId } }, select: { availability: true } }) : null;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex w-full flex-col border-b bg-sidebar md:min-h-screen md:w-60 md:border-b-0 md:border-e" data-testid="sidebar">
        <div className="flex items-center justify-between px-4 py-4">
          <Link href="/dashboard" className="text-lg font-semibold tracking-tight">
            {tc("appName")}
          </Link>
          <div className="md:hidden">
            <LocaleSwitcher locale={locale} />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0" aria-label="Main">
          {items.map((item) => (
            <NavLink key={item.href} href={item.href}>
              <item.icon className="size-4 shrink-0" aria-hidden />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-3 border-t p-4 md:block">
          <div className="space-y-1">
            <div className="truncate text-sm font-medium">{ctx.userName}</div>
            <div className="text-xs text-muted-foreground">{tr(ctx.role)}</div>
          </div>
          {membership ? <AvailabilityToggle value={membership.availability} /> : null}
          <OrgSwitcher ctx={ctx} locale={locale} />
          <div className="flex items-center justify-between gap-2">
            <LocaleSwitcher locale={locale} />
            <form action={logoutAction}>
              <input type="hidden" name="locale" value={locale} />
              <button type="submit" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="sign-out">
                <LogOut className="size-3.5" aria-hidden /> {tc("signOut")}
              </button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}
