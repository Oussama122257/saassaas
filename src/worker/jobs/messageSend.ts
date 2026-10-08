import type { Job } from "bullmq";
import type { JobPayloads } from "@/lib/queue";

/** TODO(phase 3): messaging adapter (WhatsApp Cloud API / SMS), quiet hours, one-message-per-event, credits. */
export async function handleMessageSend(job: Job<JobPayloads["message.send"]>): Promise<void> {
  const p = job.data;
  console.log(`[worker:messaging] (mock) ${p.channel} ${p.template} → ${p.to} order=${p.orderId ?? "-"}`);
}
