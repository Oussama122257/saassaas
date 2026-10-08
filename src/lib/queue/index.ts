import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

/**
 * BullMQ queues shared by the web app (producers) and the worker (consumers).
 * In tests, or when QUEUE_DISABLED=1, jobs are collected in memory so code paths stay testable
 * without Redis.
 */
export const QUEUE_NAMES = ["events", "scheduler", "messaging", "courier", "reports"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export type JobPayloads = {
  "order.status_changed": {
    orderId: string;
    merchantId: string;
    from: string | null;
    to: string;
    actorId: string | null;
    sideEffects: string[];
    payload: Record<string, unknown>;
  };
  "order.assigned": { orderId: string; merchantId: string; fromUserId: string | null; toUserId: string; rule: string };
  "scheduler.tick": { at: string };
  "message.send": { orderId: string | null; template: string; to: string; channel: "WHATSAPP" | "SMS"; vars: Record<string, string> };
};
export type JobName = keyof JobPayloads;

const QUEUE_FOR_JOB: Record<JobName, QueueName> = {
  "order.status_changed": "events",
  "order.assigned": "events",
  "scheduler.tick": "scheduler",
  "message.send": "messaging",
};

export interface MemoryJob {
  name: JobName;
  queue: QueueName;
  data: unknown;
  opts?: JobsOptions;
}

/** Jobs captured when the queue is disabled (tests). */
export const memoryJobs: MemoryJob[] = [];

function queueDisabled(): boolean {
  return process.env.QUEUE_DISABLED === "1" || process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

let connection: IORedis | null = null;
const queues = new Map<QueueName, Queue>();

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    connection.on("error", (err) => {
      console.error("[redis] connection error", err.message);
    });
  }
  return connection;
}

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts?: JobsOptions): Promise<void> {
  const queueName = QUEUE_FOR_JOB[name];
  if (queueDisabled()) {
    memoryJobs.push({ name, queue: queueName, data, opts });
    return;
  }
  try {
    await getQueue(queueName).add(name, data, opts);
  } catch (err) {
    // A failed enqueue must never undo a committed business change; log and move on.
    console.error(`[queue] failed to enqueue ${name}`, err);
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
