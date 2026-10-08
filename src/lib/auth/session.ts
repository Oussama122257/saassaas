import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { auth } from "@/auth";
import { resolveTenantContext, type TenantContext } from "@/lib/tenant";

export const ACTIVE_ORG_COOKIE = "cc_active_org";

/**
 * Tenant context for the current request (cached per request). Returns null when signed out or
 * when the user has no active membership.
 */
export const getCurrentContext = cache(async (): Promise<TenantContext | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const jar = await cookies();
  const activeOrgId = jar.get(ACTIVE_ORG_COOKIE)?.value ?? null;
  return resolveTenantContext(userId, activeOrgId);
});

export async function getSessionUser() {
  const session = await auth();
  return session?.user ?? null;
}
