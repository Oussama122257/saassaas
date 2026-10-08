import { z } from "zod";

/**
 * Typed access to environment variables. Validation is lazy so that the client bundle
 * (which never calls getEnv) does not pull Node-only concerns in, and so unit tests can run
 * without a full .env.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(16).optional(),
  APP_URL: z.string().default("http://localhost:3000"),
  ENCRYPTION_KEY: z.string().min(16),
  DEFAULT_TIMEZONE: z.string().default("Africa/Algiers"),
  TENANT_GUARD: z.string().optional(),
  ALLOW_MANUAL_CALL_PROOF: z.string().optional(),
  QUEUE_DISABLED: z.string().optional(),
  PUBLIC_TRACKING_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function isTest(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

/** Reset the cache (tests only). */
export function resetEnvCache(): void {
  cached = null;
}
