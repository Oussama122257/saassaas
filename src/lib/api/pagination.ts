import { ApiError } from "./errors";

/**
 * Cursor pagination: cursors are opaque base64url strings encoding the sort key of the last row.
 * Lists are sorted by (createdAt desc, id desc).
 */
export interface Cursor {
  createdAt: string;
  id: string;
}

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || Number.isNaN(Date.parse(parsed.createdAt))) {
      throw new Error("bad cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw ApiError.validation({ cursor: raw }, "Invalid cursor");
  }
}

export function parseLimit(raw: string | null | undefined, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw ApiError.validation({ limit: raw }, `limit must be an integer between 1 and ${max}`);
  return n;
}

/** Prisma `where` fragment selecting rows strictly after the cursor in (createdAt desc, id desc) order. */
export function cursorWhere(cursor: Cursor | null): Record<string, unknown> {
  if (!cursor) return {};
  const at = new Date(cursor.createdAt);
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] };
}

/** Trim a `limit + 1` page and compute the next cursor. */
export function page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null };
}
