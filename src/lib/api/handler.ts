import type { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { ForbiddenError, NotFoundError } from "@/lib/tenant";
import { IntakeRefusedError, OrderValidationError, TransitionError } from "@/lib/orders/orderTransitions";
import { IntakeRateLimitedError, IntakeValidationError } from "@/lib/ingest/pipeline";
import { ApiError } from "./errors";
import { fail, ok, resolveRequestId } from "./envelope";
import { authenticateApiKey, requireScope, type ApiKeyContext } from "./keys";
import { checkRateLimit, DEFAULT_RATE_LIMIT_PER_MINUTE } from "./rateLimit";
import {
  findIdempotentResponse,
  IDEMPOTENCY_REPLAY_HEADER,
  needsIdempotencyKey,
  readIdempotencyKey,
  requestHash,
  storeIdempotentResponse,
} from "./idempotency";

/**
 * Wraps a /api/v1 route handler with: request id, key auth + scope, per-org rate limit,
 * idempotency for mutating methods, and error → envelope mapping.
 */
export interface ApiRequestContext<P = Record<string, string>> {
  req: NextRequest;
  requestId: string;
  key: ApiKeyContext;
  params: P;
  /** raw body (already consumed for idempotency hashing) */
  rawBody: string;
  json<T = unknown>(): T;
}

export interface HandlerResult {
  status?: number;
  data: unknown;
  meta?: Record<string, unknown>;
}

interface Options {
  scope?: string;
  /** requests per minute per org; 0 disables */
  rateLimit?: number;
  /** override the method-based idempotency requirement */
  idempotent?: boolean;
  /** skip key auth (ping) */
  public?: boolean;
}

type RouteContext<P> = { params: Promise<P> };

export function apiHandler<P = Record<string, string>>(
  opts: Options,
  fn: (ctx: ApiRequestContext<P>) => Promise<HandlerResult>,
): (req: NextRequest, route: RouteContext<P>) => Promise<NextResponse> {
  return async (req, route) => {
    const requestId = resolveRequestId(req);
    try {
      const params = await route.params;
      const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      let key: ApiKeyContext | null = null;
      if (!opts.public) {
        key = await authenticateApiKey(req.headers.get("authorization"));
        if (opts.scope) requireScope(key, opts.scope);
        const limit = opts.rateLimit ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
        if (limit > 0) {
          const rl = await checkRateLimit(key.orgId, limit);
          if (!rl.allowed) throw ApiError.rateLimited(rl.retryAfter);
        }
      }

      const ctx: ApiRequestContext<P> = {
        req,
        requestId,
        key: key as ApiKeyContext,
        params,
        rawBody,
        json<T>() {
          if (!rawBody) return {} as T;
          try {
            return JSON.parse(rawBody) as T;
          } catch {
            throw ApiError.validation({ body: "invalid_json" }, "Request body must be valid JSON");
          }
        },
      };

      const idempotent = opts.idempotent ?? needsIdempotencyKey(req.method);
      if (idempotent && key) {
        const idemKey = readIdempotencyKey(req);
        if (!idemKey) throw new ApiError(400, "idempotency_key_required", "Idempotency-Key header is required on POST/PATCH/DELETE");
        const path = new URL(req.url).pathname;
        const hash = requestHash(req.method, path, rawBody);
        const stored = await findIdempotentResponse(key.orgId, idemKey, hash);
        if (stored) {
          const body = stored.body as { data?: unknown; error?: { code: string; message: string; details?: unknown; retry_after?: number } };
          const headers = { [IDEMPOTENCY_REPLAY_HEADER]: "1" };
          if (body.error) {
            return fail(new ApiError(stored.statusCode, body.error.code as ApiError["code"], body.error.message, body.error.details), requestId, headers);
          }
          return ok(body.data, requestId, { status: stored.statusCode, headers });
        }
        let response: NextResponse;
        let statusCode: number;
        let bodyToStore: unknown;
        try {
          const result = await fn(ctx);
          statusCode = result.status ?? 200;
          bodyToStore = { data: result.data };
          response = ok(result.data, requestId, { status: statusCode, meta: result.meta });
        } catch (err) {
          const apiErr = toApiError(err);
          statusCode = apiErr.status;
          bodyToStore = { error: { code: apiErr.code, message: apiErr.message, details: apiErr.details } };
          response = fail(apiErr, requestId);
          if (apiErr.status >= 500) console.error(`[api ${requestId}]`, err);
        }
        await storeIdempotentResponse({ orgId: key.orgId, key: idemKey, method: req.method, path, hash, statusCode, body: bodyToStore });
        return response;
      }

      const result = await fn(ctx);
      return ok(result.data, requestId, { status: result.status, meta: result.meta });
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) console.error(`[api ${requestId}]`, err);
      return fail(apiErr, requestId);
    }
  };
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return ApiError.validation(err.issues);
  if (err instanceof ForbiddenError) return ApiError.forbidden(err.message);
  if (err instanceof NotFoundError) return ApiError.notFound();
  if (err instanceof OrderValidationError) return ApiError.validation(err.details, err.message);
  if (err instanceof IntakeValidationError) return ApiError.validation(undefined, err.message);
  if (err instanceof IntakeRateLimitedError) return new ApiError(429, "rate_limited", err.message, undefined, err.retryAfterSec);
  if (err instanceof IntakeRefusedError) return new ApiError(422, "intake_refused", err.message, { reason: err.reason });
  if (err instanceof TransitionError) {
    switch (err.code) {
      case "ORDER_NOT_FOUND":
        return ApiError.notFound("Order");
      case "ILLEGAL_TRANSITION":
        return new ApiError(409, "illegal_transition", err.message, err.details);
      case "FORBIDDEN_ACTOR":
      case "NOT_ORDER_OWNER":
      case "ORDER_LOCKED":
        return ApiError.forbidden(err.message);
      case "INVALID_PAYLOAD":
        return ApiError.validation(err.details, err.message);
      case "PRECONDITION_FAILED":
        return new ApiError(422, "precondition_failed", err.message, err.details);
    }
  }
  return new ApiError(500, "internal_error", "Internal error");
}
