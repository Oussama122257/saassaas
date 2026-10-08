import { PrismaClient, Prisma } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Prisma client singleton + tenant guard.
 *
 * The guard is a Prisma client extension that throws when a query on a tenant-owned model has no
 * tenant filter. It is enabled outside production (or when TENANT_GUARD=1) and exists to catch
 * bugs early; the real isolation is done by the repository layer (src/lib/tenant.ts) which always
 * adds `merchantId in accessibleMerchantIds`.
 *
 * System code (scheduler, courier sync, seed) that legitimately works across tenants runs inside
 * `withSystemContext(...)`, which disables the guard for that async scope only.
 */

type TenantKeySpec = { direct?: string[]; viaOrder?: boolean };

const TENANT_MODELS: Record<string, TenantKeySpec> = {
  Order: { direct: ["merchantId"] },
  Customer: { direct: ["merchantId"] },
  Product: { direct: ["merchantId"] },
  Store: { direct: ["merchantId"] },
  Courier: { direct: ["merchantId"] },
  CourierRoute: { direct: ["merchantId"] },
  Warehouse: { direct: ["merchantId"] },
  StatusLabelOverride: { direct: ["merchantId"] },
  Blacklist: { direct: ["orgId"] },
  OutboundNumber: { direct: ["orgId"] },
  Warning: { direct: ["orgId"] },
  ApiKey: { direct: ["orgId"] },
  AuditLog: { direct: ["orgId"] },
  IdempotencyKey: { direct: ["orgId"] },
  Shift: { direct: ["orgId"] },
  OrderEvent: { viaOrder: true },
  OrderItem: { viaOrder: true },
  CallAttempt: { viaOrder: true },
  Task: { viaOrder: true },
  CourierEvent: { viaOrder: true },
};

const GUARDED_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
  "upsert",
]);

export class TenantGuardError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Tenant guard: ${model}.${operation} has no tenant filter. Scope the query with merchantId/orgId (or orderId / order.merchantId for child models), or run it inside withSystemContext().`,
    );
    this.name = "TenantGuardError";
  }
}

const systemScope = new AsyncLocalStorage<{ reason: string }>();

export function withSystemContext<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  // `await` inside the async wrapper so lazy Prisma promises returned without awaiting still execute
  // within the AsyncLocalStorage scope.
  return systemScope.run({ reason }, async () => await fn());
}

export function inSystemContext(): boolean {
  return systemScope.getStore() !== undefined;
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // `in: []` is a legitimate "sees nothing" scope (e.g. an agency with no active contract)
    return hasValue(o.equals) || Array.isArray(o.in) || hasValue(o.contains);
  }
  return true;
}

function whereHasKeys(where: unknown, keys: string[], depth = 0): boolean {
  if (!where || typeof where !== "object" || depth > 6) return false;
  const w = where as Record<string, unknown>;
  for (const k of keys) {
    if (hasValue(w[k])) return true;
    // compound unique keys such as merchantId_phone / merchantId_seq / orgId_key
    for (const prop of Object.keys(w)) {
      if ((prop.startsWith(`${k}_`) || prop.endsWith(`_${k}`)) && w[prop] && typeof w[prop] === "object") {
        const compound = w[prop] as Record<string, unknown>;
        if (hasValue(compound[k])) return true;
      }
    }
  }
  if (Array.isArray(w.AND) && w.AND.some((x) => whereHasKeys(x, keys, depth + 1))) return true;
  if (w.AND && !Array.isArray(w.AND) && whereHasKeys(w.AND, keys, depth + 1)) return true;
  if (Array.isArray(w.OR) && w.OR.length > 0 && w.OR.every((x) => whereHasKeys(x, keys, depth + 1))) return true;
  return false;
}

function whereIsOrderScoped(where: unknown): boolean {
  if (!where || typeof where !== "object") return false;
  const w = where as Record<string, unknown>;
  if (hasValue(w.orderId)) return true;
  if (w.order && typeof w.order === "object") {
    const o = w.order as Record<string, unknown>;
    if (whereHasKeys(o, ["merchantId"])) return true;
    if (o.is && whereHasKeys(o.is, ["merchantId"])) return true;
  }
  if (Array.isArray(w.AND) && w.AND.some((x) => whereIsOrderScoped(x))) return true;
  if (Array.isArray(w.OR) && w.OR.length > 0 && w.OR.every((x) => whereIsOrderScoped(x))) return true;
  return false;
}

export function assertTenantScoped(model: string | undefined, operation: string, args: unknown): void {
  if (!model || !GUARDED_OPERATIONS.has(operation)) return;
  const spec = TENANT_MODELS[model];
  if (!spec) return;
  if (inSystemContext()) return;
  const where = (args as { where?: unknown } | undefined)?.where;
  if (spec.direct && whereHasKeys(where, spec.direct)) return;
  if (spec.viaOrder && whereIsOrderScoped(where)) return;
  throw new TenantGuardError(model, operation);
}

function guardEnabled(): boolean {
  if (process.env.TENANT_GUARD === "0") return false;
  if (process.env.TENANT_GUARD === "1") return true;
  return process.env.NODE_ENV !== "production";
}

function createClient() {
  const base = new PrismaClient({
    log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
  });
  // The extension is always installed so the client has one static type; the check itself is
  // skipped at runtime in production (guardEnabled()).
  return base.$extends({
    name: "tenantGuard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (guardEnabled()) assertTenantScoped(model, operation, args);
          return query(args);
        },
      },
    },
  });
}

type Client = ReturnType<typeof createClient>;
type TxCallback = Extract<Parameters<Client["$transaction"]>[0], (...args: never[]) => unknown>;

const globalForPrisma = globalThis as unknown as { __prisma?: Client };

export const prisma: Client = globalForPrisma.__prisma ?? createClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__prisma = prisma;

export type Db = Client;
/** Client type usable both for the root client and inside $transaction callbacks. */
export type DbClient = Parameters<TxCallback>[0];

export { Prisma };
