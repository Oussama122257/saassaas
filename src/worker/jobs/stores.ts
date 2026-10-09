import type { Job } from "bullmq";
import type { JobPayloads } from "@/lib/queue";
import { prisma, withSystemContext } from "@/lib/db";
import { pollDzbuild, pollSheet, shopifyBackfill, shopifySubscribeWebhooks, writeBackStatus } from "@/lib/stores/service";

export async function handleStoreWriteback(job: Job<JobPayloads["store.writeback"]>): Promise<void> {
  const r = await writeBackStatus(job.data.orderId, job.data.status);
  console.log(`[worker:stores] write-back ${job.data.orderId} ${job.data.status}: ${r}`);
}

async function loadStore(storeId: string) {
  return withSystemContext("store-job", () => prisma.store.findFirst({ where: { id: storeId, merchantId: { not: "" } } }));
}

async function markError(storeId: string, merchantId: string, err: unknown) {
  await withSystemContext("store-job", () => prisma.store.update({ where: { id: storeId, merchantId }, data: { lastError: (err as Error).message.slice(0, 500) } }));
}

export async function handleStorePoll(job: Job<JobPayloads["store.poll"]>): Promise<void> {
  const store = await loadStore(job.data.storeId);
  if (!store || !store.active || store.connection === "DISCONNECTED") return;
  try {
    if (store.channel === "DZBUILD") console.log(`[worker:stores] dzbuild poll ${store.id}`, await pollDzbuild(store));
    if (store.channel === "GOOGLE_SHEET") console.log(`[worker:stores] sheet poll ${store.id}`, await pollSheet(store));
  } catch (err) {
    await markError(store.id, store.merchantId, err);
    throw err;
  }
}

export async function handleStoreBackfill(job: Job<JobPayloads["store.backfill"]>): Promise<void> {
  const store = await loadStore(job.data.storeId);
  if (!store || store.channel !== "SHOPIFY") return;
  try {
    const appUrl = process.env.APP_URL;
    if (appUrl) await shopifySubscribeWebhooks(store, appUrl);
    console.log(`[worker:stores] shopify backfill ${store.id}`, await shopifyBackfill(store, { days: job.data.days }));
  } catch (err) {
    await markError(store.id, store.merchantId, err);
    throw err;
  }
}

/** Enqueue polls for stores without webhooks (Google Sheets) and DZBuild's safety net, every 10 minutes. */
export async function enqueueDuePolls(enqueuePoll: (storeId: string) => Promise<void>): Promise<number> {
  const due = new Date(Date.now() - 10 * 60_000);
  const stores = await withSystemContext("store-poll", () =>
    prisma.store.findMany({ where: { active: true, connection: { not: "DISCONNECTED" }, channel: { in: ["DZBUILD", "GOOGLE_SHEET"] }, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: due } }], merchantId: { not: "" } }, select: { id: true, channel: true, credentials: true, settings: true } }),
  );
  let n = 0;
  for (const s of stores) {
    const configured = s.channel === "DZBUILD" ? !!s.credentials : !!(s.settings as { sheet?: { sheetId?: string } }).sheet?.sheetId;
    if (!configured) continue;
    await enqueuePoll(s.id);
    n++;
  }
  return n;
}
