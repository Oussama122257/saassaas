"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getCurrentContext } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit";
import { hasRole } from "@/lib/tenant";
import { isOrderStatus } from "@/lib/orders/statuses";

/** Save per-merchant label overrides. Empty values remove the override. Codes never change. */
export async function saveStatusLabelsAction(input: { merchantId: string; labels: Array<{ code: string; labelFr: string; labelAr: string }> }): Promise<{ ok: boolean; message?: string }> {
  const ctx = await getCurrentContext();
  if (!ctx || !hasRole(ctx, ["ORG_OWNER", "SUPERVISOR"])) return { ok: false, message: "Forbidden" };
  if (!ctx.accessibleMerchantIds.includes(input.merchantId)) return { ok: false, message: "No access to this merchant" };
  let changed = 0;
  for (const l of input.labels) {
    if (!isOrderStatus(l.code)) continue;
    const labelFr = l.labelFr.trim().slice(0, 60) || null;
    const labelAr = l.labelAr.trim().slice(0, 60) || null;
    if (!labelFr && !labelAr) {
      const r = await prisma.statusLabelOverride.deleteMany({ where: { merchantId: input.merchantId, code: l.code } });
      changed += r.count;
      continue;
    }
    await prisma.statusLabelOverride.upsert({
      where: { merchantId_code: { merchantId: input.merchantId, code: l.code } },
      create: { merchantId: input.merchantId, code: l.code, labelFr, labelAr },
      update: { labelFr, labelAr },
    });
    changed++;
  }
  await writeAuditLog(ctx, { action: "STATUS_LABELS_UPDATED", targetType: "Organization", targetId: input.merchantId, payload: { changed } });
  revalidatePath(`/${ctx.locale}/settings/statuses`);
  return { ok: true };
}
