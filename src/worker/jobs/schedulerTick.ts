import type { Job } from "bullmq";
import type { JobPayloads } from "@/lib/queue";
import { withSystemContext } from "@/lib/db";
import { purgeExpiredIdempotencyKeys } from "@/lib/api/idempotency";

/**
 * Runs every minute. Phase 1: housekeeping only.
 * TODO(phase 2): reassignment rules (section 9.2), call slot scheduling (section 8), INJOIGNABLE after 9 attempts.
 * TODO(phase 4): stuck parcel detection, stop-desk reminders, courier polling.
 */
export async function handleSchedulerTick(_job: Job<JobPayloads["scheduler.tick"]>): Promise<void> {
  await withSystemContext("scheduler-tick", async () => {
    const purged = await purgeExpiredIdempotencyKeys();
    if (purged > 0) console.log(`[worker:scheduler] purged ${purged} expired idempotency keys`);
  });
}
