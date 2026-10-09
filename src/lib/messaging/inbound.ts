import { prisma, withSystemContext } from "@/lib/db";
import { transitionOrder, TransitionError } from "@/lib/orders/orderTransitions";
import { systemContext } from "@/lib/tenant";
import type { WaInbound } from "@/lib/adapters/messaging/whatsappCloud";

/**
 * WhatsApp inbound processing: delivery statuses update MessageLog; a reply on the
 * bot_confirm_request button ("I confirm") moves the order to CONFIRMEE_BOT through the state
 * machine (high-value / risky orders get a verification task instead of shipping — section 7.3).
 */
export interface InboundReport {
  statusesUpdated: number;
  botConfirmed: string[];
  ignored: number;
}

const STATUS_MAP: Record<string, string> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

export async function processWhatsAppInbound(inbound: WaInbound): Promise<InboundReport> {
  return withSystemContext("whatsapp-inbound", async () => {
    const report: InboundReport = { statusesUpdated: 0, botConfirmed: [], ignored: 0 };
    for (const s of inbound.statuses) {
      const status = STATUS_MAP[s.status];
      if (!status) continue;
      const now = new Date();
      const r = await prisma.messageLog.updateMany({
        where: { providerId: s.id },
        data: { status, ...(status === "DELIVERED" ? { deliveredAt: now } : {}), ...(status === "READ" ? { readAt: now } : {}), ...(s.error ? { error: s.error } : {}) },
      });
      report.statusesUpdated += r.count;
    }
    for (const reply of inbound.buttonReplies) {
      let orderId: string | null = null;
      const m = reply.payload.match(/^CONFIRM:(.+)$/);
      if (m) orderId = m[1]!;
      else if (reply.contextId) {
        const log = await prisma.messageLog.findFirst({ where: { providerId: reply.contextId, template: "bot_confirm_request" } });
        orderId = log?.orderId ?? null;
      }
      if (!orderId) {
        report.ignored++;
        continue;
      }
      // the reply must come from the order's customer
      const order = await prisma.order.findFirst({ where: { id: orderId }, select: { customerPhone: true } });
      const from = reply.from.startsWith("213") ? `0${reply.from.slice(3)}` : reply.from;
      if (!order || order.customerPhone !== from) {
        report.ignored++;
        continue;
      }
      try {
        await transitionOrder(systemContext("whatsapp-bot"), { orderId, to: "CONFIRMEE_BOT", payload: { messageId: reply.contextId ?? undefined } });
        report.botConfirmed.push(orderId);
      } catch (err) {
        if (!(err instanceof TransitionError)) throw err;
        report.ignored++;
      }
    }
    return report;
  });
}
