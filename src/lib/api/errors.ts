/**
 * Stable, documented error codes for the public API (section 19b.6).
 */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "insufficient_scope"
  | "not_found"
  | "validation_error"
  | "rate_limited"
  | "idempotency_key_required"
  | "idempotency_key_reuse"
  | "conflict"
  | "illegal_transition"
  | "precondition_failed"
  | "intake_refused"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static unauthorized(message = "Missing or invalid API key") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "Forbidden") {
    return new ApiError(403, "forbidden", message);
  }
  static insufficientScope(scope: string) {
    return new ApiError(403, "insufficient_scope", `This key lacks the "${scope}" scope`, { required_scope: scope });
  }
  static notFound(what = "Resource") {
    return new ApiError(404, "not_found", `${what} not found`);
  }
  static validation(details: unknown, message = "Validation failed") {
    return new ApiError(400, "validation_error", message, details);
  }
  static rateLimited(retryAfter: number) {
    return new ApiError(429, "rate_limited", "Too many requests", undefined, retryAfter);
  }
}
