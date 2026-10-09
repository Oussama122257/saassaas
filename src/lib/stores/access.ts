import { prisma } from "@/lib/db";
import { ForbiddenError, hasRole, type TenantContext } from "@/lib/tenant";

/** Stores an org owner / supervisor may configure (own merchant, or contracted merchants for an agency). */
export async function requireStoreAdmin(ctx: TenantContext, storeId: string) {
  if (!hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) throw new ForbiddenError("Only owners and supervisors manage stores");
  const store = await prisma.store.findFirst({ where: { id: storeId, merchantId: { in: ctx.accessibleMerchantIds } } });
  if (!store) throw new ForbiddenError("Store not found");
  return store;
}
