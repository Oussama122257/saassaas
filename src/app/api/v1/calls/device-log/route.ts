import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateDevice } from "@/lib/devices/tokens";
import { attachCallRecords } from "@/lib/calls/proof";
import { resolveRequestId } from "@/lib/api/envelope";

/**
 * Android companion → device call log (section 8.3, proof DEVICE_LOG). Contract documented in
 * docs/android-companion.md. Auth: `Authorization: Device <token>` (paired from the Devices page).
 */
const body = z.object({
  entries: z
    .array(
      z.object({
        call_ref: z.string().max(100).nullable().optional(),
        number: z.string().min(4).max(30),
        started_at: z.string().datetime({ offset: true }),
        duration_sec: z.number().int().min(0).max(36_000),
        type: z.enum(["OUTGOING", "INCOMING", "MISSED"]).default("OUTGOING"),
      }),
    )
    .min(1)
    .max(200),
});

export async function POST(req: NextRequest) {
  const requestId = resolveRequestId(req);
  const device = await authenticateDevice(req.headers.get("authorization"));
  if (!device) return NextResponse.json({ error: { code: "unauthorized", message: "Unknown or revoked device token" }, meta: { request_id: requestId } }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "validation_error", message: "Invalid body", details: parsed.error.issues }, meta: { request_id: requestId } }, { status: 400 });
  const outgoing = parsed.data.entries.filter((e) => e.type === "OUTGOING");
  const r = await attachCallRecords(
    outgoing.map((e) => ({ callRef: e.call_ref ?? null, to: e.number, agentId: device.userId, startedAt: new Date(e.started_at), durationSec: e.duration_sec, proof: "DEVICE_LOG" as const, raw: e })),
    device.userId,
  );
  return NextResponse.json({ data: { received: parsed.data.entries.length, matched: r.matched, unmatched: r.unmatched }, meta: { request_id: requestId } });
}
