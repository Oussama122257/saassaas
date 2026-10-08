import type { OrgType, Prisma, Role } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { PRE_CONFIRMATION_STATUSES } from "@/lib/orders/statuses";

/**
 * Tenant context (section 5.3). Every repository function takes an ActorContext and scopes its
 * queries with tenantWhere()/orderAccessWhere(). System jobs use a SystemContext.
 */
export interface TenantContext {
  kind: "user";
  userId: string;
  userName: string;
  orgId: string;
  orgType: OrgType;
  orgName: string;
  role: Role;
  podId: string | null;
  /** merchants whose data this org may see (own org for merchants, contracted merchants for agencies) */
  accessibleMerchantIds: string[];
  isPlatformAdmin: boolean;
  locale: string;
  timezone: string;
  /** other orgs the user belongs to (for the org switcher) */
  memberships: Array<{ orgId: string; orgName: string; orgType: OrgType; role: Role }>;
}

export interface SystemContext {
  kind: "system";
  reason: string;
}

export type ActorContext = TenantContext | SystemContext;

export const SYSTEM_ACTOR = "SYSTEM" as const;
export type ActorRole = Role | typeof SYSTEM_ACTOR;

export const SUPERVISOR_PLUS: Role[] = ["SUPERVISOR", "ORG_OWNER", "PLATFORM_ADMIN"];
export const AGENT_ROLES: Role[] = ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT"];
export const READ_ONLY_ROLES: Role[] = ["CLIENT_VIEWER", "MARKETER", "READ_ONLY"];

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export function systemContext(reason: string): SystemContext {
  return { kind: "system", reason };
}

export function actorRole(ctx: ActorContext): ActorRole {
  return ctx.kind === "system" ? SYSTEM_ACTOR : ctx.role;
}

export function isSupervisorPlus(ctx: ActorContext): boolean {
  return ctx.kind === "system" || SUPERVISOR_PLUS.includes(ctx.role) || ctx.isPlatformAdmin;
}

export function hasRole(ctx: ActorContext, roles: Role[]): boolean {
  if (ctx.kind === "system") return true;
  if (ctx.isPlatformAdmin) return true;
  return roles.includes(ctx.role);
}

export function requireRole(ctx: ActorContext, roles: Role[]): void {
  if (!hasRole(ctx, roles)) throw new ForbiddenError(`Requires one of: ${roles.join(", ")}`);
}

export function requireUser(ctx: ActorContext): TenantContext {
  if (ctx.kind !== "user") throw new ForbiddenError("A signed-in user is required");
  return ctx;
}

export function isReadOnly(ctx: ActorContext): boolean {
  return ctx.kind === "user" && READ_ONLY_ROLES.includes(ctx.role) && !ctx.isPlatformAdmin;
}

/** Base tenant filter for merchant-owned models. */
export function tenantWhere(ctx: TenantContext): { merchantId: { in: string[] } } {
  return { merchantId: { in: ctx.accessibleMerchantIds } };
}

/**
 * Order visibility (section 4.3):
 *  - confirmation agent: only orders assigned to them
 *  - follow-up agent: orders of their pod from the confirmation decision onward, plus orders assigned to them
 *  - everyone else in the org: all orders of accessible merchants
 */
export function orderAccessWhere(ctx: TenantContext): Prisma.OrderWhereInput {
  const base: Prisma.OrderWhereInput = tenantWhere(ctx);
  if (ctx.isPlatformAdmin) return base;
  switch (ctx.role) {
    case "CONFIRMATION_AGENT":
      return { AND: [base, { assignedToId: ctx.userId }] };
    case "FOLLOWUP_AGENT":
      return {
        AND: [
          base,
          {
            OR: [
              { assignedToId: ctx.userId },
              ...(ctx.podId ? [{ podId: ctx.podId, status: { notIn: PRE_CONFIRMATION_STATUSES } }] : []),
            ],
          },
        ],
      };
    default:
      return base;
  }
}

/**
 * Resolve the tenant context for a signed-in user. `activeOrgId` comes from a cookie set by the org
 * switcher; it falls back to the first active membership.
 */
export async function resolveTenantContext(userId: string, activeOrgId?: string | null): Promise<TenantContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        where: { active: true, org: { active: true } },
        include: { org: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!user || !user.active) return null;
  const memberships = user.memberships;
  const membership = memberships.find((m) => m.orgId === activeOrgId) ?? memberships[0];
  if (!membership) return null;

  const org = membership.org;
  let accessibleMerchantIds: string[];
  if (org.type === "MERCHANT") {
    accessibleMerchantIds = [org.id];
  } else {
    const contracts = await prisma.serviceContract.findMany({
      where: { agencyId: org.id, status: { in: ["TRIAL", "ACTIVE"] } },
      select: { merchantId: true },
    });
    accessibleMerchantIds = contracts.map((c) => c.merchantId);
  }

  const isPlatformAdmin = user.isPlatformAdmin || membership.role === "PLATFORM_ADMIN";

  return {
    kind: "user",
    userId: user.id,
    userName: user.name,
    orgId: org.id,
    orgType: org.type,
    orgName: org.name,
    role: membership.role,
    podId: membership.podId,
    accessibleMerchantIds,
    isPlatformAdmin,
    locale: user.locale,
    timezone: org.timezone,
    memberships: memberships.map((m) => ({ orgId: m.orgId, orgName: m.org.name, orgType: m.org.type, role: m.role })),
  };
}

/** Run a function with the tenant guard disabled (system jobs, seed, cross-tenant admin). */
export function asSystem<T>(reason: string, fn: (ctx: SystemContext) => Promise<T>): Promise<T> {
  return withSystemContext(reason, () => fn(systemContext(reason)));
}
