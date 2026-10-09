import { prisma, type DbClient } from "@/lib/db";

/**
 * Prepaid messaging credits (section 19b.1): one ledger per merchant org. Messages that are
 * skipped (non-mobile, duplicate, quiet hours) are never charged.
 */
export async function creditBalance(orgId: string, db: DbClient = prisma): Promise<number> {
  const last = await db.messageCreditLedger.findFirst({ where: { orgId }, orderBy: { createdAt: "desc" }, select: { balanceAfter: true } });
  return last?.balanceAfter ?? 0;
}

/** Atomic debit; returns false when the balance is insufficient. */
export async function debitCredits(orgId: string, amount: number, messageLogId: string | null): Promise<boolean> {
  if (amount <= 0) return true;
  return prisma.$transaction(async (tx) => {
    // serialize per org
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`;
    const balance = await creditBalance(orgId, tx);
    if (balance < amount) return false;
    await tx.messageCreditLedger.create({ data: { orgId, delta: -amount, balanceAfter: balance - amount, reason: "MESSAGE", messageLogId } });
    return true;
  });
}

export async function topUpCredits(orgId: string, amount: number, opts: { actorId?: string | null; note?: string; reason?: "TOPUP" | "ADJUSTMENT" | "REFUND" } = {}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`;
    const balance = await creditBalance(orgId, tx);
    const after = balance + amount;
    await tx.messageCreditLedger.create({ data: { orgId, delta: amount, balanceAfter: after, reason: opts.reason ?? "TOPUP", actorId: opts.actorId ?? null, note: opts.note } });
    return after;
  });
}
