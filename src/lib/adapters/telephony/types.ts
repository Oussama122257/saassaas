/**
 * Telephony adapter (section 8.3). Algerian teams mostly call from mobile SIMs, so three proof
 * sources sit behind one interface: DEVICE_LOG (Android companion), VOIP_LOG (provider CDR), NONE.
 */
export interface CallRecord {
  callRef: string | null;
  /** number dialed (national format) */
  to?: string;
  agentId?: string;
  startedAt: Date;
  durationSec: number;
  /** provider outcome when known */
  outcome?: "ANSWERED" | "NO_ANSWER" | "BUSY" | "OFF" | "FAILED";
  recordingUrl?: string;
  proof: "VOIP_LOG" | "DEVICE_LOG";
  raw?: unknown;
}

export interface StartCallResult {
  callRef: string;
  /** what the agent's device opens: tel: link, companion deep link, or null when the provider rings the agent */
  dialUri: string | null;
}

export interface TelephonyAdapter {
  provider: string;
  startCall(params: { agentId: string; to: string; fromNumberId: string | null; fromMsisdn: string | null; orderId: string; callRef: string }): Promise<StartCallResult>;
  handleWebhook(req: Request): Promise<CallRecord[]>;
}
