# Android companion app — call proof (section 8.3, proof `DEVICE_LOG`)

Algerian confirmation teams call from mobile SIMs. The platform cannot see those calls, so a small
Android companion app places the call from the agent's SIM and reports the device call log back.
Every attempt the agent logs then carries a real proof (number, start time, duration).

This document is the contract the app implements. The server side is done
(`src/app/api/v1/calls/device-log/route.ts`, `src/lib/calls/proof.ts`); the app itself is a
separate project (native Kotlin, or a PWA + a minimal Android helper).

## 1. Pairing

1. The agent opens **Téléphones / الهواتف** (`/[locale]/devices`) and taps *Appairer un téléphone*.
2. The page shows a one-time JSON configuration:
   ```json
   { "apiBase": "https://app.example.dz/api/v1", "deviceToken": "dev_…", "deepLinkScheme": "codcc" }
   ```
3. The app stores it (Android Keystore). Supervisors can revoke a device from the same page.

Only the SHA-256 of the token is stored server side (`DeviceToken`).

## 2. Placing a call

On the call screen the *Appeler* button calls `startCallAction`, which creates a `CallSession`
(`callRef`, order, agent, outbound number A/B/C) and opens:

```
codcc://dial?ref=<callRef>&to=0550123456&from=0660000002
```

The app registers the `codcc` scheme, places the call with `ACTION_CALL` (permission
`CALL_PHONE`), choosing the SIM whose number equals `from` when the phone has two SIMs
(`TelecomManager` / `PhoneAccountHandle`). The plain `tel:` link remains as a fallback when the app
is not installed (the attempt then needs manual mode).

## 3. Reporting the call log

After the call ends (listen to `PhoneStateListener` / `TelephonyCallback`, then read
`CallLog.Calls` with permission `READ_CALL_LOG`), the app posts the matching entries:

```http
POST {apiBase}/calls/device-log
Authorization: Device dev_…
Content-Type: application/json

{
  "entries": [
    { "call_ref": "c_…", "number": "0550123456", "started_at": "2026-10-09T10:15:03+01:00", "duration_sec": 47, "type": "OUTGOING" }
  ]
}
```

Response: `{ "data": { "received": 1, "matched": 1, "unmatched": 0 }, "meta": { "request_id": "…" } }`.

Matching: by `call_ref` first; otherwise same agent + same number within 15 minutes of the
session start. Only `OUTGOING` entries are used. `duration_sec > 0` means the call connected.

Retries: queue entries locally and retry with exponential backoff; posting the same entry twice
is harmless (the session already has its proof).

## 4. What the platform does with it

* The call screen polls the session; when the proof arrives it shows the duration and suggests the
  outcome. The agent's click logs the attempt with `proof = DEVICE_LOG`, the real start time and
  duration.
* If the agent forgets to log an outcome, the scheduler logs it automatically after
  `telephony.autoLogAfterMin` (default 10 min) from the proof — a proven call is never lost.
* Attempts without proof are rejected unless the org enables manual mode; manual attempts are
  flagged `MANUAL_PROOF` and lower the agent's *proof rate* KPI (section 15).

## 5. Privacy

The app sends only calls placed through the platform (`call_ref`) or to numbers of orders assigned
to the agent; it must not upload the personal call history.
