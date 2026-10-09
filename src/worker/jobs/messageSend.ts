import type { Job } from "bullmq";
import { enqueue, type JobPayloads } from "@/lib/queue";
import { sendOrderMessage } from "@/lib/messaging/send";
import { isTemplateKey } from "@/lib/messaging/templates";

/** Sends one order message; messages that fall in quiet hours are re-queued for the next allowed minute. */
export async function handleMessageSend(job: Job<JobPayloads["message.send"]>): Promise<void> {
  const p = job.data;
  if (!p.orderId || !isTemplateKey(p.template)) {
    console.log(`[worker:messaging] skipped ${p.template} (no order or unknown template)`);
    return;
  }
  const r = await sendOrderMessage(p.orderId, p.template, { vars: p.vars, channel: p.channel });
  if (r.status === "DEFERRED" && r.deferUntil) {
    const delay = Math.max(0, r.deferUntil.getTime() - Date.now());
    await enqueue("message.send", p, { delay, jobId: `msg:${p.orderId}:${p.template}:${r.deferUntil.getTime()}` });
  }
  console.log(`[worker:messaging] ${p.template} → order ${p.orderId}: ${r.status}${r.channel !== p.channel ? ` via ${r.channel}` : ""}`);
}
