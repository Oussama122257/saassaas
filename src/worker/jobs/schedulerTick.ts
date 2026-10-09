import type { Job } from "bullmq";
import { enqueue, type JobPayloads } from "@/lib/queue";
import { withSystemContext } from "@/lib/db";
import { purgeExpiredIdempotencyKeys } from "@/lib/api/idempotency";
import { runConfirmationTick } from "@/lib/calls/scheduler";
import { enqueueDuePolls } from "./stores";

/**
 * Runs every minute: confirmation engine jobs (assignment, reassignment rules, call cadence,
 * locks, unreachable, nightly expiry, recycle, number health), store polling, housekeeping.
 * TODO(phase 4): stuck-order watchdog, stop-desk reminders, courier polling.
 */
export async function handleSchedulerTick(_job: Job<JobPayloads["scheduler.tick"]>): Promise<void> {
  const now = new Date();
  await runConfirmationTick(now);
  await enqueueDuePolls((storeId) => enqueue("store.poll", { storeId }, { jobId: `poll:${storeId}:${Math.floor(now.getTime() / 600_000)}` }));
  await withSystemContext("scheduler-tick", async () => {
    const purged = await purgeExpiredIdempotencyKeys();
    if (purged > 0) console.log(`[worker:scheduler] purged ${purged} expired idempotency keys`);
  });
}
