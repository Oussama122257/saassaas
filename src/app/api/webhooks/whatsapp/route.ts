import { NextResponse, type NextRequest } from "next/server";
import { parseWhatsAppWebhook, verifyMetaSignature } from "@/lib/adapters/messaging/whatsappCloud";
import { processWhatsAppInbound } from "@/lib/messaging/inbound";
import { recordReceipt, finishReceipt } from "@/lib/stores/service";

/** Meta verification handshake: hub.mode=subscribe & hub.verify_token → echo hub.challenge. */
export function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (url.searchParams.get("hub.mode") === "subscribe" && token && url.searchParams.get("hub.verify_token") === token) {
    return new NextResponse(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/** Delivery statuses + button replies (bot confirmation). Signed with X-Hub-Signature-256. */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET ?? "")) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const receipt = await recordReceipt({ provider: "whatsapp", storeId: null, topic: "whatsapp", deliveryId: null, rawBody: raw, verified: true, payload });
  if (receipt.duplicate) return NextResponse.json({ ok: true, duplicate: true });
  const report = await processWhatsAppInbound(parseWhatsAppWebhook(payload));
  await finishReceipt(receipt.id, "PROCESSED");
  return NextResponse.json({ ok: true, ...report });
}
