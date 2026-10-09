"use server";

import { revalidatePath } from "next/cache";
import { getCurrentContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { hasRole } from "@/lib/tenant";

/** Replace an agent's weekly shifts (weekday 0 = Sunday, minutes since midnight, org timezone). */
export async function saveShiftsAction(input: { userId: string; days: number[]; startMin: number; endMin: number }): Promise<{ ok: boolean; message?: string }> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) return { ok: false, message: "Forbidden" };
  const member = await prisma.membership.findFirst({ where: { userId: input.userId, orgId: ctx.orgId } });
  if (!member) return { ok: false, message: "Not a member of this organization" };
  if (input.endMin <= input.startMin) return { ok: false, message: "End must be after start" };
  await prisma.shift.deleteMany({ where: { orgId: ctx.orgId, userId: input.userId } });
  await prisma.shift.createMany({ data: [...new Set(input.days)].filter((d) => d >= 0 && d <= 6).map((weekday) => ({ orgId: ctx.orgId, userId: input.userId, weekday, startMin: input.startMin, endMin: input.endMin })) });
  await writeAuditLog(ctx, { action: "SETTINGS_UPDATED", targetType: "Shift", targetId: input.userId, payload: input });
  revalidatePath(`/${ctx.locale}/team`);
  return { ok: true };
}
