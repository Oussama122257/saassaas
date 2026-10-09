import { safeEqual } from "@/lib/crypto";
import type { CallRecord, StartCallResult, TelephonyAdapter } from "./types";

/**
 * Android companion (DEVICE_LOG): the platform opens a deep link the companion app handles; the
 * app places the call from the agent's SIM and posts the device call log back to
 * POST /api/v1/calls/device-log (see docs/android-companion.md). Plain `tel:` when the app is absent.
 */
export class DeviceTelephonyAdapter implements TelephonyAdapter {
  readonly provider = "device";
  async startCall(p: Parameters<TelephonyAdapter["startCall"]>[0]): Promise<StartCallResult> {
    const q = new URLSearchParams({ ref: p.callRef, to: p.to, ...(p.fromMsisdn ? { from: p.fromMsisdn } : {}) });
    return { callRef: p.callRef, dialUri: `codcc://dial?${q.toString()}` };
  }
  async handleWebhook(): Promise<CallRecord[]> {
    return []; // device logs arrive through the device-log endpoint, not a provider webhook
  }
}

/**
 * Mock VoIP provider for development and tests: click-to-call returns a tel: link and the "CDR"
 * webhook is a JSON body { callRef, durationSec, outcome, recordingUrl } with header
 * X-Telephony-Secret = TELEPHONY_WEBHOOK_SECRET.
 */
export class MockVoipAdapter implements TelephonyAdapter {
  readonly provider = "mock";
  async startCall(p: Parameters<TelephonyAdapter["startCall"]>[0]): Promise<StartCallResult> {
    return { callRef: p.callRef, dialUri: `tel:${p.to}` };
  }
  async handleWebhook(req: Request): Promise<CallRecord[]> {
    const secret = process.env.TELEPHONY_WEBHOOK_SECRET ?? "";
    const sent = req.headers.get("x-telephony-secret") ?? "";
    if (!secret || !safeEqual(sent, secret)) throw new Error("invalid_signature");
    const body = (await req.json()) as { callRef: string; durationSec?: number; outcome?: CallRecord["outcome"]; recordingUrl?: string; startedAt?: string } | Array<{ callRef: string; durationSec?: number; outcome?: CallRecord["outcome"]; recordingUrl?: string; startedAt?: string }>;
    return (Array.isArray(body) ? body : [body]).map((b) => ({
      callRef: b.callRef,
      startedAt: b.startedAt ? new Date(b.startedAt) : new Date(),
      durationSec: b.durationSec ?? 0,
      outcome: b.outcome,
      recordingUrl: b.recordingUrl,
      proof: "VOIP_LOG" as const,
      raw: b,
    }));
  }
}

/**
 * Real VoIP provider: TODO(owner) — choose the SIP/VoIP provider (section 26, question 2), then
 * implement click-to-call, the CDR webhook (signature check) and recording URLs from its official
 * API documentation. Never guess its endpoints.
 */
export class PendingVoipAdapter implements TelephonyAdapter {
  constructor(readonly provider: string) {}
  async startCall(): Promise<StartCallResult> {
    throw new Error(`VoIP provider "${this.provider}" is not implemented yet`);
  }
  async handleWebhook(): Promise<CallRecord[]> {
    throw new Error(`VoIP provider "${this.provider}" is not implemented yet`);
  }
}

export function telephonyAdapterFor(mode: "DEVICE" | "VOIP" | "MANUAL", provider: string): TelephonyAdapter {
  if (mode === "DEVICE") return new DeviceTelephonyAdapter();
  if (provider === "mock") return new MockVoipAdapter();
  return new PendingVoipAdapter(provider);
}

export type { CallRecord, TelephonyAdapter };
