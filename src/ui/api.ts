export type ApiErrorExtras = Record<string, unknown>;
export type FetchJson = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ApiRetryPolicy = {
  delaysMs: readonly number[];
  wait: (delayMs: number, signal?: AbortSignal | null) => Promise<void>;
};

export class ApiError extends Error {
  readonly code: string;
  readonly extras: ApiErrorExtras;
  readonly status: number;

  constructor(status: number, code: string, message: string, extras: ApiErrorExtras = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extras = extras;
  }
}

export async function getJson<T>(
  path: string,
  init?: RequestInit,
  fetcher: FetchJson = fetch,
  retryPolicy: ApiRetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  for (let attempt = 0; ; attempt += 1) {
    const retryDelay = retryPolicy.delaysMs[attempt];
    let response: Response;
    try {
      response = await fetcher(path, { ...init, headers });
    } catch (error) {
      if (
        error instanceof TypeError &&
        isSafeMethod(init?.method) &&
        retryDelay != null &&
        init?.signal?.aborted !== true
      ) {
        await retryPolicy.wait(retryDelay, init?.signal);
        continue;
      }
      throw error;
    }
    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON failures still retain the status fallback below.
    }
    const message =
      typeof payload.error === "string" && payload.error !== ""
        ? payload.error
        : `${response.status} ${response.statusText}`.trim();
    const code =
      typeof payload.code === "string" && payload.code !== "" ? payload.code : "request_failed";
    const { error: _error, code: _code, ...extras } = payload;
    if (payload.retryable === true && retryDelay != null && init?.signal?.aborted !== true) {
      await retryPolicy.wait(retryDelay, init?.signal);
      continue;
    }
    throw new ApiError(response.status, code, message, extras);
  }
}

function isSafeMethod(method: string | undefined): boolean {
  const normalized = method?.toUpperCase() ?? "GET";
  return normalized === "GET" || normalized === "HEAD";
}

const DEFAULT_RETRY_POLICY: ApiRetryPolicy = {
  delaysMs: [150, 400, 900],
  wait: (delayMs, signal) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
