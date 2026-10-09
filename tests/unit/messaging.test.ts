import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhook, signMeta, verifyMetaSignature, WhatsAppCloudAdapter } from "@/lib/adapters/messaging/whatsappCloud";
import { toInternational } from "@/lib/adapters/messaging/types";
import { DEFAULT_TEMPLATES, renderTemplate, TEMPLATE_KEYS } from "@/lib/messaging/templates";

describe("message templates (section 11)", () => {
  it("has the 10 default templates in FR and AR", () => {
    expect(TEMPLATE_KEYS).toHaveLength(10);
    for (const k of TEMPLATE_KEYS) {
      expect(DEFAULT_TEMPLATES[k].fr.length).toBeGreaterThan(10);
      expect(DEFAULT_TEMPLATES[k].ar.length).toBeGreaterThan(10);
    }
  });
  it("renders variables and drops unknown ones", () => {
    expect(renderTemplate("Bonjour {customer_name}, total {total} {unknown}", { customer_name: "Amine", total: "7 000 DA" })).toBe("Bonjour Amine, total 7 000 DA");
  });
  it("formats WhatsApp numbers", () => {
    expect(toInternational("0550123456")).toBe("213550123456");
  });
});

describe("WhatsApp Cloud adapter", () => {
  it("verifies X-Hub-Signature-256", () => {
    const body = '{"entry":[]}';
    expect(verifyMetaSignature(body, signMeta(body, "s"), "s")).toBe(true);
    expect(verifyMetaSignature(body, signMeta(body, "s"), "other")).toBe(false);
    expect(verifyMetaSignature(body, null, "s")).toBe(false);
  });

  it("parses statuses, button replies and texts", () => {
    const p = parseWhatsAppWebhook({
      entry: [{ changes: [{ value: {
        statuses: [{ id: "wamid.1", status: "delivered" }],
        messages: [
          { from: "213550123456", type: "button", button: { payload: "CONFIRM:o1", text: "Je confirme" }, context: { id: "wamid.0" } },
          { from: "213550123456", type: "interactive", interactive: { button_reply: { id: "CONFIRM:o2" } } },
          { from: "213550123456", type: "text", text: { body: "salam" } },
        ],
      } }] }],
    });
    expect(p.statuses).toEqual([{ id: "wamid.1", status: "delivered", error: undefined }]);
    expect(p.buttonReplies.map((b) => b.payload)).toEqual(["CONFIRM:o1", "CONFIRM:o2"]);
    expect(p.buttonReplies[0]!.contextId).toBe("wamid.0");
    expect(p.texts[0]!.text).toBe("salam");
  });

  it("sends template messages with body parameters and buttons", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const fake = async (url: string, init?: RequestInit) => {
      sent = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
    };
    const a = new WhatsAppCloudAdapter("tok", "123", "v21.0", fake);
    const r = await a.send({ to: "213550123456", text: "", template: { name: "bot_confirm", language: "ar", bodyParams: ["Amine", "7000"], quickReplyPayload: "CONFIRM:o1" } });
    expect(r).toEqual({ providerId: "wamid.X", status: "SENT" });
    expect(sent!.url).toBe("https://graph.facebook.com/v21.0/123/messages");
    expect(sent!.body).toMatchObject({ messaging_product: "whatsapp", to: "213550123456", type: "template", template: { name: "bot_confirm", language: { code: "ar" } } });
    const failing = new WhatsAppCloudAdapter("tok", "123", "v21.0", async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }));
    expect(await failing.send({ to: "x", text: "hi" })).toEqual({ providerId: null, status: "FAILED", error: "bad" });
  });
});
