import { getRedisConnection } from "@/lib/queue";

/**
 * Per-org, per-minute fixed-window rate limiter shared by all keys of the org (section 19b.6).
 * Backed by Redis (INCR + EXPIRE); falls back to an in-process window when Redis is disabled
 * (tests) or unreachable, so the API degrades gracefully instead of failing closed on an outage.
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** seconds until the window resets */
  retryAfter: number;
  resetAt: number;
}

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

const memory = new Map<string, { count: number; windowStart: number }>();

function memoryBackend(): boolean {
  return process.env.QUEUE_DISABLED === "1" || process.env.VITEST === "true" || process.env.NODE_ENV === "test" || process.env.RATE_LIMIT_MEMORY === "1";
}

function memoryHit(key: string, limit: number, now: number): RateLimitResult {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const entry = memory.get(key);
  const count = entry && entry.windowStart === windowStart ? entry.count + 1 : 1;
  memory.set(key, { count, windowStart });
  if (memory.size > 10_000) {
    for (const [k, v] of memory) if (v.windowStart !== windowStart) memory.delete(k);
  }
  const resetAt = windowStart + 60_000;
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfter: Math.ceil((resetAt - now) / 1000), resetAt };
}

export async function checkRateLimit(orgId: string, limit = DEFAULT_RATE_LIMIT_PER_MINUTE, now = Date.now()): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const key = `ratelimit:org:${orgId}:${windowStart}`;
  if (memoryBackend()) return memoryHit(`org:${orgId}`, limit, now);
  try {
    const redis = getRedisConnection();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 70);
    const resetAt = windowStart + 60_000;
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfter: Math.ceil((resetAt - now) / 1000), resetAt };
  } catch (err) {
    console.error("[ratelimit] redis unavailable, using in-memory window", (err as Error).message);
    return memoryHit(`org:${orgId}`, limit, now);
  }
}

/** Tests only. */
export function resetRateLimitMemory(): void {
  memory.clear();
}
