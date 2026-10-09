/** Shared fetch type so adapters can be tested with a fake implementation. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AdapterError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function readJson<T = unknown>(res: Response, provider: string): Promise<T> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new AdapterError(provider, `Invalid JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
  }
}
