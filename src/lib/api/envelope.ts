import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ApiError } from "./errors";

export const API_VERSION = "2026-10";
export const REQUEST_ID_HEADER = "X-Request-Id";
export const API_VERSION_HEADER = "X-Api-Version";

export interface Meta {
  request_id: string;
  api_version: string;
  [key: string]: unknown;
}

/** Use the client-sent request id when present (max 128 chars, safe charset), else mint one. */
export function resolveRequestId(req: Request): string {
  const sent = req.headers.get(REQUEST_ID_HEADER)?.trim();
  if (sent && /^[A-Za-z0-9._:-]{1,128}$/.test(sent)) return sent;
  return randomUUID();
}

function baseHeaders(requestId: string, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set(REQUEST_ID_HEADER, requestId);
  h.set(API_VERSION_HEADER, API_VERSION);
  h.set("Cache-Control", "no-store");
  return h;
}

export function ok<T>(data: T, requestId: string, init?: { status?: number; meta?: Record<string, unknown>; headers?: HeadersInit }): NextResponse {
  const body = { data, meta: { request_id: requestId, api_version: API_VERSION, ...(init?.meta ?? {}) } satisfies Meta };
  return NextResponse.json(body, { status: init?.status ?? 200, headers: baseHeaders(requestId, init?.headers) });
}

export function fail(err: ApiError, requestId: string, headers?: HeadersInit): NextResponse {
  const h = baseHeaders(requestId, headers);
  if (err.retryAfter !== undefined) h.set("Retry-After", String(err.retryAfter));
  const body = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      ...(err.retryAfter !== undefined ? { retry_after: err.retryAfter } : {}),
    },
    meta: { request_id: requestId, api_version: API_VERSION } satisfies Meta,
  };
  return NextResponse.json(body, { status: err.status, headers: h });
}
