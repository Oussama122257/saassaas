/**
 * Worker entrypoint (second process of the same codebase). Run with `pnpm worker`.
 * Consumes the BullMQ queues produced by the web app and runs the scheduler tick.
 */
import { Worker, type Job } from "bullmq";
import { closeQueues, getQueue, getRedisConnection, QUEUE_NAMES, type JobName, type JobPayloads, type QueueName } from "@/lib/queue";
import { prisma } from "@/lib/db";
import { handleStatusChanged } from "./jobs/statusChanged";
import { handleOrderAssigned } from "./jobs/orderAssigned";
import { handleSchedulerTick } from "./jobs/schedulerTick";
import { handleMessageSend } from "./jobs/messageSend";

type Handler<N extends JobName> = (job: Job<JobPayloads[N]>) => Promise<void>;

const handlers: { [N in JobName]: Handler<N> } = {
  "order.status_changed": handleStatusChanged,
  "order.assigned": handleOrderAssigned,
  "scheduler.tick": handleSchedulerTick,
  "message.send": handleMessageSend,
};

function log(scope: string, msg: string, extra?: unknown) {
  console.log(`[worker:${scope}] ${new Date().toISOString()} ${msg}`, extra !== undefined ? JSON.stringify(extra) : "");
}

async function main() {
  // Load .env for standalone runs (Node >= 20.12 has process.loadEnvFile).
  try {
    process.loadEnvFile?.(".env");
  } catch {
    /* no .env file: rely on the environment */
  }
  const connection = getRedisConnection();
  await connection.connect().catch(() => undefined);

  const workers: Worker[] = QUEUE_NAMES.map(
    (name: QueueName) =>
      new Worker(
        name,
        async (job) => {
          const handler = handlers[job.name as JobName] as Handler<JobName> | undefined;
          if (!handler) {
            log(name, `no handler for job ${job.name}`);
            return;
          }
          await handler(job as Job<JobPayloads[JobName]>);
        },
        { connection, concurrency: name === "scheduler" ? 1 : 5 },
      ),
  );
  for (const w of workers) {
    w.on("failed", (job, err) => log(w.name, `job ${job?.name} ${job?.id} failed: ${err.message}`));
    w.on("error", (err) => log(w.name, `worker error: ${err.message}`));
  }

  // Scheduler tick every minute (reassignment rules, call slots, SLA checks arrive in phase 2).
  await getQueue("scheduler").upsertJobScheduler("scheduler-tick", { every: 60_000 }, { name: "scheduler.tick", data: { at: new Date().toISOString() } });
  log("main", `started ${workers.length} workers`, { queues: QUEUE_NAMES });

  const shutdown = async (signal: string) => {
    log("main", `received ${signal}, shutting down`);
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
