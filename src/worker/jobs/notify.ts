import type { Job } from "bullmq";
import type { JobPayloads } from "@/lib/queue";

/** Owner notifications (Telegram / email). TODO(phase 5): Telegram bot adapter with TELEGRAM_BOT_TOKEN. */
export async function handleNotifyOwner(job: Job<JobPayloads["notify.owner"]>): Promise<void> {
  console.log(`[worker:notify] ${job.data.kind} org=${job.data.orgId}: ${job.data.message}`);
}
