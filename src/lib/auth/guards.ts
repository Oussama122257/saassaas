import "server-only";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { hasRole, type TenantContext } from "@/lib/tenant";
import { getCurrentContext } from "./session";

/** Server-component guard: signed in with an active membership, else go to the login page. */
export async function requireContext(locale: string): Promise<TenantContext> {
  const ctx = await getCurrentContext();
  if (!ctx) redirect(`/${locale}/login`);
  return ctx;
}

/** Server-component guard: context + one of the given roles, else back to the dashboard. */
export async function requirePageRole(locale: string, roles: Role[]): Promise<TenantContext> {
  const ctx = await requireContext(locale);
  if (!hasRole(ctx, roles)) redirect(`/${locale}/dashboard?forbidden=1`);
  return ctx;
}
