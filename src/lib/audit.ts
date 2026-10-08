import type { Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import type { ActorContext } from "@/lib/tenant";

/**
 * Org-level audit log (section 21: overrides, impersonation, exports, API keys, settings).
 * Order-level changes are recorded in OrderEvent by the transitions service.
 */
export type AuditAction =
  | "LOGIN"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "TOTP_ENABLED"
  | "TOTP_DISABLED"
  | "ORDER_OVERRIDE"
  | "ORDERS_EXPORT"
  | "ORDERS_BULK_REASSIGN"
  | "API_KEY_CREATED"
  | "API_KEY_REVOKED"
  | "SETTINGS_UPDATED"
  | "STATUS_LABELS_UPDATED"
  | "IMPERSONATION_START"
  | "IMPERSONATION_END";

export async function writeAuditLog(
  ctx: ActorContext,
  entry: {
    orgId?: string;
    action: AuditAction;
    targetType?: string;
    targetId?: string;
    payload?: Prisma.InputJsonValue;
    ip?: string | null;
  },
  db: DbClient = prisma,
): Promise<void> {
  const orgId = entry.orgId ?? (ctx.kind === "user" ? ctx.orgId : undefined);
  if (!orgId) return;
  await db.auditLog.create({
    data: {
      orgId,
      actorId: ctx.kind === "user" ? ctx.userId : null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      payload: entry.payload ?? {},
      ip: entry.ip ?? undefined,
    },
  });
}
