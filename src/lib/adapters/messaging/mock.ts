import { randomUUID } from "node:crypto";
import type { MessagingAdapter, OutboundMessage, SendResult } from "./types";

/** In-memory adapter for development and tests. Numbers ending in 0000 fail (to exercise fallbacks). */
export const mockOutbox: Array<{ channel: string; msg: OutboundMessage; providerId: string }> = [];

export class MockMessagingAdapter implements MessagingAdapter {
  readonly provider = "mock";
  constructor(readonly channel: "WHATSAPP" | "SMS") {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.to.endsWith("0000")) return { providerId: null, status: "FAILED", error: "mock failure" };
    const providerId = `${this.channel === "WHATSAPP" ? "wamid" : "sms"}.${randomUUID()}`;
    mockOutbox.push({ channel: this.channel, msg, providerId });
    return { providerId, status: "SENT" };
  }
}

/**
 * SMS gateway placeholder. TODO(owner): pick the local SMS provider (section 26, question 3) and
 * implement send() from its official API documentation. Until then SMS go through the mock.
 */
export class PendingSmsGatewayAdapter implements MessagingAdapter {
  readonly channel = "SMS" as const;
  readonly provider = "sms_gateway_pending";
  async send(): Promise<SendResult> {
    return { providerId: null, status: "FAILED", error: "SMS provider not configured (owner to choose)" };
  }
}
