import { NextResponse, type NextRequest } from "next/server";
import { telephonyAdapterFor } from "@/lib/adapters/telephony";
import { attachCallRecords } from "@/lib/calls/proof";

/** VoIP provider CDR webhook (proof VOIP_LOG). Signature verification is the adapter's job. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  try {
    const records = await telephonyAdapterFor("VOIP", provider).handleWebhook(req);
    const r = await attachCallRecords(records);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    const msg = (err as Error).message;
    return NextResponse.json({ ok: false, error: msg }, { status: msg === "invalid_signature" ? 401 : 400 });
  }
}
