import { randomUUID } from "node:crypto";
import { prisma, withSystemContext } from "@/lib/db";
import { loadOpsContext, pickOutboundNumber, transitionOrder, TransitionError } from "@/lib/orders/orderTransitions";
import { nextAttemptStatus } from "@/lib/orders/transitions";
import { CLAIMABLE_STATUSES } from "@/lib/orders/statuses";
import { normalizePhone } from "@/lib/phone";
import { orderAccessWhere, systemContext, type TenantContext } from "@/lib/tenant";
import { telephonyAdapterFor, type CallRecord } from "@/lib/adapters/telephony";

/**
 * Call proof (section 8.3). Click-to-call opens a CallSession; the proof (device call log or VoIP
 * CDR) is attached to the session; the attempt the agent logs carries that proof. Attempts without
 * proof are rejected unless the org enabled manual mode (then flagged MANUAL_PROOF).
 */
export async function startCall(ctx: TenantContext, orderId: string): Promise<{ callRef: string; dialUri: string | null; numberLabel: string | null }> {
  const order = await prisma.order.findFirst({ where: { AND: [{ id: orderId }, orderAccessWhere(ctx)] } });
  if (!order) throw new TransitionError("ORDER_NOT_FOUND", "Order not found");
  const ops = await loadOpsContext(prisma, order);
  const numberId = await pickOutboundNumber(prisma, ops.teamOrgId, order.id);
  const number = numberId ? await prisma.outboundNumber.findFirst({ where: { id: numberId, orgId: ops.teamOrgId ?? "" } }) : null;
  const adapter = telephonyAdapterFor(ops.settings.telephony.mode, ops.settings.telephony.provider);
  const callRef = `c_${randomUUID()}`;
  const r = await adapter.startCall({ agentId: ctx.userId, to: order.customerPhone, fromNumberId: numberId ?? null, fromMsisdn: number?.msisdn ?? null, orderId: order.id, callRef });
  await prisma.callSession.create({ data: { callRef, provider: adapter.provider, orderId: order.id, agentId: ctx.userId, phoneNumberId: numberId ?? null, to: order.customerPhone } });
  return { callRef, dialUri: r.dialUri, numberLabel: number?.label ?? null };
}

/** Match records (device log or CDR) to sessions: by callRef, else same agent + number within 15 minutes. */
export async function attachCallRecords(records: CallRecord[], agentId?: string): Promise<{ matched: number; unmatched: number }> {
  return withSystemContext("call-proof", async () => {
    let matched = 0;
    let unmatched = 0;
    for (const rec of records) {
      let session = rec.callRef ? await prisma.callSession.findUnique({ where: { callRef: rec.callRef } }) : null;
      if (!session && (agentId ?? rec.agentId) && rec.to) {
        const to = normalizePhone(rec.to).phone ?? rec.to;
        session = await prisma.callSession.findFirst({
          where: { agentId: agentId ?? rec.agentId, to, proof: "NONE", startedAt: { gte: new Date(rec.startedAt.getTime() - 15 * 60_000), lte: new Date(rec.startedAt.getTime() + 2 * 60_000) } },
          orderBy: { startedAt: "desc" },
        });
      }
      if (!session || (agentId && session.agentId !== agentId)) {
        unmatched++;
        continue;
      }
      const answered = rec.outcome ? rec.outcome === "ANSWERED" : rec.durationSec > 0;
      await prisma.callSession.update({
        where: { id: session.id },
        data: {
          proof: rec.proof,
          durationSec: rec.durationSec,
          startedAt: rec.startedAt,
          endedAt: new Date(rec.startedAt.getTime() + rec.durationSec * 1000),
          answeredAt: answered ? rec.startedAt : null,
          recordingUrl: rec.recordingUrl ?? session.recordingUrl,
          status: answered ? "ANSWERED" : rec.outcome === "BUSY" || rec.outcome === "OFF" ? rec.outcome : "NO_ANSWER",
          raw: (rec.raw ?? {}) as object,
        },
      });
      matched++;
    }
    return { matched, unmatched };
  });
}

export interface ProofForAttempt {
  sessionId: string;
  proof: "VOIP_LOG" | "DEVICE_LOG";
  startedAt: Date;
  durationSec: number;
  recordingUrl: string | null;
  phoneNumberId: string | null;
  suggestedOutcome: "ANSWERED" | "NO_ANSWER" | "BUSY" | "OFF";
}

/** Latest unconsumed session of this agent on this order (last 30 minutes), with its proof if it arrived. */
export async function pendingSession(orderId: string, agentId: string) {
  return prisma.callSession.findFirst({
    where: { orderId, agentId, attemptId: null, startedAt: { gte: new Date(Date.now() - 30 * 60_000) }, order: { merchantId: { not: "" } } },
    orderBy: { startedAt: "desc" },
  });
}

export function proofOf(session: NonNullable<Awaited<ReturnType<typeof pendingSession>>>): ProofForAttempt | null {
  if (session.proof === "NONE") return null;
  return {
    sessionId: session.id,
    proof: session.proof,
    startedAt: session.startedAt,
    durationSec: session.durationSec ?? 0,
    recordingUrl: session.recordingUrl,
    phoneNumberId: session.phoneNumberId,
    suggestedOutcome: session.status === "ANSWERED" ? "ANSWERED" : session.status === "BUSY" ? "BUSY" : session.status === "OFF" ? "OFF" : "NO_ANSWER",
  };
}

export async function linkSessionToAttempt(sessionId: string, attemptId: string): Promise<void> {
  await withSystemContext("call-proof", () => prisma.callSession.update({ where: { id: sessionId }, data: { attemptId } }));
}

/**
 * Calls with proof but no outcome from the agent after N minutes are logged automatically with the
 * outcome the proof shows, so no proven call is ever lost from the attempt counter.
 */
export async function autoLogStaleSessions(now = new Date()): Promise<number> {
  return withSystemContext("call-proof", async () => {
    const sessions = await prisma.callSession.findMany({
      where: { attemptId: null, proof: { not: "NONE" }, endedAt: { lt: new Date(now.getTime() - 5 * 60_000) }, order: { status: { in: CLAIMABLE_STATUSES.concat("EN_COURS_CONFIRMATION") } } },
      include: { order: true },
      take: 100,
    });
    let n = 0;
    for (const s of sessions) {
      const ops = await loadOpsContext(prisma, s.order);
      if (!s.endedAt || now.getTime() - s.endedAt.getTime() < ops.settings.telephony.autoLogAfterMin * 60_000) continue;
      const p = proofOf(s)!;
      try {
        const r = await transitionOrder(systemContext("call-autolog"), {
          orderId: s.orderId,
          to: nextAttemptStatus(s.order.attemptCount),
          payload: { call: { outcome: p.suggestedOutcome, proof: p.proof, startedAt: p.startedAt, durationSec: p.durationSec, recordingUrl: p.recordingUrl ?? undefined, phoneNumberId: p.phoneNumberId ?? undefined, agentId: s.agentId, note: "auto-logged from call proof" } },
        });
        const attemptId = (r.event.payload as { callAttemptId?: string }).callAttemptId;
        if (attemptId) await linkSessionToAttempt(s.id, attemptId);
        n++;
      } catch (err) {
        if (!(err instanceof TransitionError)) throw err;
        await prisma.callSession.update({ where: { id: s.id }, data: { attemptId: "REJECTED" } });
      }
    }
    return n;
  });
}
