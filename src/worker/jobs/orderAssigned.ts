import type { Job } from "bullmq";
import type { JobPayloads } from "@/lib/queue";

/** TODO(phase 2): push the order into the agent's live queue (SSE) and notify them. */
export async function handleOrderAssigned(job: Job<JobPayloads["order.assigned"]>): Promise<void> {
  const p = job.data;
  console.log(`[worker:events] order ${p.orderId} assigned ${p.fromUserId ?? "∅"} → ${p.toUserId} (${p.rule})`);
}
