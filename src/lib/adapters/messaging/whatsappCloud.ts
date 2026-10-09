import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/crypto";
import type { FetchLike } from "@/lib/adapters/stores/http";
import type { MessagingAdapter, OutboundMessage, SendResult } from "./types";

/**
 * WhatsApp Business Cloud API (section 11).
 * Send: POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * Template messages: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 * Webhooks (verify token + X-Hub-Signature-256): https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export class WhatsAppCloudAdapter implements MessagingAdapter {
  readonly channel = "WHATSAPP" as const;
  readonly provider = "whatsapp_cloud";
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly version = process.env.WHATSAPP_API_VERSION || "v21.0",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const body: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to: msg.to };
    if (msg.template) {
      const components: unknown[] = [];
      if (msg.template.bodyParams.length) components.push({ type: "body", parameters: msg.template.bodyParams.map((text) => ({ type: "text", text })) });
      if (msg.template.urlButtonParam) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: msg.template.urlButtonParam }] });
      if (msg.template.quickReplyPayload) components.push({ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: msg.template.quickReplyPayload }] });
      body.type = "template";
      body.template = { name: msg.template.name, language: { code: msg.template.language }, components };
    } else {
      body.type = "text";
      body.text = { preview_url: true, body: msg.text };
    }
    const res = await this.fetchImpl(`https://graph.facebook.com/${this.version}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } };
    if (!res.ok || !json.messages?.[0]?.id) return { providerId: null, status: "FAILED", error: json.error?.message ?? `HTTP ${res.status}` };
    return { providerId: json.messages[0].id, status: "SENT" };
  }
}

/** X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of the raw body with the app secret. */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqual(expected, header.slice(7));
}

export function signMeta(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

export interface WaInbound {
  statuses: Array<{ id: string; status: string; error?: string }>;
  buttonReplies: Array<{ from: string; payload: string; contextId: string | null }>;
  texts: Array<{ from: string; text: string; contextId: string | null }>;
}

/** Extract delivery statuses, button replies and texts from a webhook payload. */
export function parseWhatsAppWebhook(payload: unknown): WaInbound {
  const out: WaInbound = { statuses: [], buttonReplies: [], texts: [] };
  const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: Record<string, unknown> }> }> }).entry ?? [];
  for (const e of entries) {
    for (const ch of e.changes ?? []) {
      const v = ch.value ?? {};
      for (const s of (v.statuses as Array<{ id: string; status: string; errors?: Array<{ title?: string }> }>) ?? []) {
        out.statuses.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title });
      }
      for (const m of (v.messages as Array<Record<string, unknown>>) ?? []) {
        const from = String(m.from ?? "");
        const contextId = ((m.context as { id?: string } | undefined)?.id) ?? null;
        if (m.type === "button") {
          const b = m.button as { payload?: string; text?: string };
          out.buttonReplies.push({ from, payload: b.payload ?? b.text ?? "", contextId });
        } else if (m.type === "interactive") {
          const i = m.interactive as { button_reply?: { id: string } };
          if (i.button_reply) out.buttonReplies.push({ from, payload: i.button_reply.id, contextId });
        } else if (m.type === "text") {
          out.texts.push({ from, text: (m.text as { body?: string })?.body ?? "", contextId });
        }
      }
    }
  }
  return out;
}
