export interface OutboundMessage {
  /** E.164 without "+" for WhatsApp (213XXXXXXXXX), national for SMS */
  to: string;
  text: string;
  /** WhatsApp template message (business-initiated) */
  template?: { name: string; language: string; bodyParams: string[]; urlButtonParam?: string; quickReplyPayload?: string };
}

export interface SendResult {
  providerId: string | null;
  status: "SENT" | "FAILED";
  error?: string;
}

export interface MessagingAdapter {
  channel: "WHATSAPP" | "SMS";
  provider: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** 0550123456 → 213550123456 */
export function toInternational(phone: string): string {
  return phone.startsWith("0") ? `213${phone.slice(1)}` : phone.replace(/^\+/, "");
}
