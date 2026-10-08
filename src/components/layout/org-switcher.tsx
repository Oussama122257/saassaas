import { getTranslations } from "next-intl/server";
import type { TenantContext } from "@/lib/tenant";
import { switchOrgAction } from "@/lib/auth/actions";

export async function OrgSwitcher({ ctx, locale }: { ctx: TenantContext; locale: string }) {
  const t = await getTranslations("common");
  if (ctx.memberships.length <= 1) {
    return <span className="truncate text-sm font-medium" data-testid="active-org">{ctx.orgName}</span>;
  }
  return (
    <form action={switchOrgAction} className="flex items-center gap-2">
      <input type="hidden" name="locale" value={locale} />
      <label className="sr-only" htmlFor="orgId">
        {t("switchOrg")}
      </label>
      <select
        id="orgId"
        name="orgId"
        defaultValue={ctx.orgId}
        className="h-8 rounded-md border bg-background px-2 text-sm"
        data-testid="active-org"
      >
        {ctx.memberships.map((m) => (
          <option key={m.orgId} value={m.orgId}>
            {m.orgName}
          </option>
        ))}
      </select>
      <button type="submit" className="text-xs underline">
        {t("switchOrg")}
      </button>
    </form>
  );
}
