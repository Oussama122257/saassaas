import type { MsgChannel, Prisma } from "@prisma/client";
import { prisma, withSystemContext } from "@/lib/db";
import { loadOpsContext } from "@/lib/orders/orderTransitions";
import { blockedReason, nextAllowedTime } from "@/lib/calls/slots";
import { normalizePhone } from "@/lib/phone";
import { wilayaName } from "@/lib/wilayas";
import { formatDzd } from "@/lib/utils";
import { enqueue } from "@/lib/queue";
import { smsAdapter, whatsappAdapter } from "@/lib/adapters/messaging";
import { toInternational, type MessagingAdapter } from "@/lib/adapters/messaging/types";
import { DEFAULT_TEMPLATES, renderTemplate, type TemplateKey } from "./templates";
import { debitCredits, topUpCredits } from "./credits";
import { ensureTrackingToken, shortLink, trackingUrl } from "@/lib/tracking";

/**
 * Order messaging pipeline (sections 11, 19b.1, 19b.5):
 *   one message per event per order · Algerian mobiles (05/06/07) only · quiet hours (same blocked
 *   windows as calls) → deferred · prepaid credits (skipped messages are never charged, failed ones
 *   are refunded) · WhatsApp first, SMS fallback where the template allows it · every message logged.
 */
export type SendStatus = "SENT" | "FAILED" | "SKIPPED_DUPLICATE" | "SKIPPED_NOT_MOBILE" | "SKIPPED_NO_CREDIT" | "SKIPPED_DISABLED" | "DEFERRED";

export interface SendOutcome {
  status: SendStatus;
  channel: MsgChannel;
  messageLogId?: string;
  deferUntil?: Date;
  providerId?: string | null;
}

export interface SendOptions {
  vars?: Record<string, string>;
  channel?: "WHATSAPP" | "SMS";
  now?: Date;
  adapters?: { whatsapp?: MessagingAdapter; sms?: MessagingAdapter };
}

const LIVE_STATUSES = ["QUEUED", "SENT", "DELIVERED", "READ"];

async function resolveBody(merchantId: string, key: TemplateKey, channel: MsgChannel, lang: "fr" | "ar") {
  const rows = await prisma.messageTemplate.findMany({ where: { key, channel, lang, active: true, OR: [{ merchantId }, { merchantId: null }] } });
  const own = rows.find((r) => r.merchantId === merchantId) ?? rows.find((r) => r.merchantId === null);
  return { body: own?.body ?? DEFAULT_TEMPLATES[key][lang], waTemplateName: own?.waTemplateName ?? null, waLanguage: own?.waLanguage ?? (lang === "ar" ? "ar" : "fr") };
}

export async function sendOrderMessage(orderId: string, key: TemplateKey, opts: SendOptions = {}): Promise<SendOutcome> {
  return withSystemContext("messaging", async () => {
    const now = opts.now ?? new Date();
    const channel: MsgChannel = opts.channel ?? "WHATSAPP";
    const order = await prisma.order.findFirst({
      where: { id: orderId },
      include: { store: { select: { name: true } }, items: { take: 3, include: { product: { select: { name: true } } } }, merchant: { select: { settings: true } } },
    });
    if (!order) return { status: "FAILED", channel };
    const ops = await loadOpsContext(prisma, order);
    const msgSettings = ops.settings.messaging;
    if (msgSettings.disabledTemplates.includes(key)) return { status: "SKIPPED_DISABLED", channel };

    // one message per event per order
    const prior = await prisma.messageLog.findFirst({ where: { orderId, template: key, status: { in: LIVE_STATUSES } } });
    if (prior) return { status: "SKIPPED_DUPLICATE", channel, messageLogId: prior.id };

    const lang = msgSettings.language;
    const phone = normalizePhone(order.customerPhone);
    const base = { orderId, orgId: order.merchantId, channel, template: key, to: order.customerPhone, lang };
    const logSkip = async (status: SendStatus) => {
      const row = await prisma.messageLog.upsert({
        where: { orderId_template_channel: { orderId, template: key, channel } },
        create: { ...base, status, cost: 0 },
        update: { status, cost: 0, sentAt: now },
      });
      return { status, channel, messageLogId: row.id } satisfies SendOutcome;
    };
    if (phone.type !== "MOBILE") return logSkip("SKIPPED_NOT_MOBILE");

    // quiet hours: defer, never send inside blocked windows
    if (blockedReason(now, ops.settings.calls, ops.timezone)) {
      return { status: "DEFERRED", channel, deferUntil: nextAllowedTime(now, ops.settings.calls, ops.timezone) };
    }

    const token = await ensureTrackingToken(order.id);
    const fullUrl = trackingUrl(token, lang);
    const vars: Record<string, string> = {
      customer_name: order.customerName ?? "",
      product: order.items.map((i) => i.product.name).join(", "),
      total: formatDzd(order.total, lang),
      wilaya: wilayaName(order.wilayaCode, lang),
      store_name: order.store.name,
      tracking_url: channel === "SMS" ? await shortLink(fullUrl, order.id) : fullUrl,
      ...opts.vars,
    };
    const tpl = await resolveBody(order.merchantId, key, channel, lang);
    const text = renderTemplate(tpl.body, vars);
    const cost = channel === "WHATSAPP" ? msgSettings.costWhatsApp : msgSettings.costSms;

    let log;
    try {
      log = await prisma.messageLog.upsert({
        where: { orderId_template_channel: { orderId, template: key, channel } },
        create: { ...base, status: "QUEUED", body: text, cost },
        update: { status: "QUEUED", body: text, cost, error: null, sentAt: now },
      });
    } catch {
      return { status: "SKIPPED_DUPLICATE", channel };
    }

    if (msgSettings.creditsEnforced && cost > 0) {
      const ok = await debitCredits(order.merchantId, cost, log.id);
      if (!ok) {
        await prisma.messageLog.update({ where: { id: log.id }, data: { status: "SKIPPED_NO_CREDIT", cost: 0 } });
        await enqueue("notify.owner", { orgId: order.merchantId, kind: "NO_MESSAGING_CREDIT", message: `Message ${key} for order #${order.seq} skipped: no messaging credits left` });
        return { status: "SKIPPED_NO_CREDIT", channel, messageLogId: log.id };
      }
    }

    const adapter = channel === "WHATSAPP" ? opts.adapters?.whatsapp ?? whatsappAdapter() : opts.adapters?.sms ?? smsAdapter();
    const def = DEFAULT_TEMPLATES[key];
    const result = await adapter
      .send({
        to: channel === "WHATSAPP" ? toInternational(phone.phone!) : phone.phone!,
        text,
        template: channel === "WHATSAPP" && tpl.waTemplateName
          ? { name: tpl.waTemplateName, language: tpl.waLanguage, bodyParams: def.waParams.map((p) => vars[p] ?? ""), urlButtonParam: token, quickReplyPayload: def.quickReply ? `${def.quickReply}:${order.id}` : undefined }
          : undefined,
      })
      .catch((err: Error) => ({ providerId: null, status: "FAILED" as const, error: err.message }));

    await prisma.messageLog.update({ where: { id: log.id }, data: { status: result.status, providerId: result.providerId, error: result.error ?? null, cost: result.status === "SENT" ? cost : 0 } });
    if (result.status === "FAILED") {
      if (msgSettings.creditsEnforced && cost > 0) await topUpCredits(order.merchantId, cost, { reason: "REFUND", note: `failed ${key}` });
      if (channel === "WHATSAPP" && def.smsFallback) return sendOrderMessage(orderId, key, { ...opts, channel: "SMS" });
      return { status: "FAILED", channel, messageLogId: log.id };
    }
    await prisma.orderEvent.create({ data: { orderId, type: "MESSAGE_SENT", payload: { template: key, channel, providerId: result.providerId } as Prisma.InputJsonValue } });
    return { status: "SENT", channel, messageLogId: log.id, providerId: result.providerId };
  });
}
