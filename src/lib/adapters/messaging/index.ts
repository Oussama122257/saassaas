import { MockMessagingAdapter, PendingSmsGatewayAdapter } from "./mock";
import { WhatsAppCloudAdapter } from "./whatsappCloud";
import type { MessagingAdapter } from "./types";

/** WhatsApp Cloud when WHATSAPP_TOKEN + WHATSAPP_PHONE_ID are set, mock otherwise. */
export function whatsappAdapter(): MessagingAdapter {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (token && phoneId && process.env.MESSAGING_MOCK !== "1") return new WhatsAppCloudAdapter(token, phoneId);
  return new MockMessagingAdapter("WHATSAPP");
}

export function smsAdapter(): MessagingAdapter {
  const provider = process.env.SMS_PROVIDER ?? "mock";
  if (provider === "mock" || process.env.MESSAGING_MOCK === "1") return new MockMessagingAdapter("SMS");
  return new PendingSmsGatewayAdapter();
}

export type { MessagingAdapter };
