import {
  ApiError,
  AuthenticationError,
  MindUploadConnectionError,
  MindUploadError,
  RateLimitError,
} from "./errors";
import { VERSION } from "./version";

export const DEFAULT_BASE_URL = "https://partner.mindupload.app";
const AUTH_HEADER = "X-Partner-Key";
// Only server backpressure is retried. Operations are non-idempotent POSTs (rag
// spends credits, create* mutate), so 5xx / network failures are surfaced
// immediately rather than risking a duplicate side effect.
const RETRY_STATUSES = new Set([429]);

/** A response envelope. `success` and `error_message` are always present; any
 * other field the API returns is available by its documented (snake_case) name. */
export interface Result {
  success: boolean;
  error_message?: string | null;
  [key: string]: unknown;
}

export interface ClientOptions {
  /** Your partner key. A server-side secret — never ship it to a browser. */
  partnerKey: string;
  baseUrl?: string;
  /** Default locale sent with every call (per-call `preferredLanguage` overrides). */
  preferredLanguage?: string;
  timeoutMs?: number;
  /** Retries only explicit 429 rate-limit responses, with backoff. Default 2. */
  maxRetries?: number;
  userAgent?: string;
}

// Minimal ambient shapes so the SDK does not depend on the DOM lib.
interface FetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}
type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
) => Promise<FetchResponse>;

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

function toBody(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) out[camelToSnake(key)] = value;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

/** Transport, retry, and error handling shared by every operation. */
export class MindUploadBase {
  protected readonly partnerKey: string;
  protected readonly baseUrl: string;
  protected readonly preferredLanguage?: string;
  protected readonly timeoutMs: number;
  protected readonly maxRetries: number;
  protected readonly userAgent: string;
  private readonly fetchFn: FetchFn;

  constructor(options: ClientOptions) {
    if (!options || !options.partnerKey) {
      throw new Error(
        "partnerKey is required. It is a server-side secret \u2014 never expose it to a browser or ship it in client code.",
      );
    }
    this.partnerKey = options.partnerKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.preferredLanguage = options.preferredLanguage;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxRetries = options.maxRetries ?? 2;
    this.userAgent = options.userAgent ?? `mindupload-js/${VERSION}`;
    const globalFetch = (globalThis as { fetch?: FetchFn }).fetch;
    if (!globalFetch) {
      throw new Error("global fetch is not available; use Node 18+, Deno, Bun, or an edge runtime.");
    }
    this.fetchFn = globalFetch.bind(globalThis);
  }

  protected async request(operation: string, params: Record<string, unknown>): Promise<Result> {
    const body = toBody(params);
    if (body["preferred_language"] === undefined && this.preferredLanguage !== undefined) {
      body["preferred_language"] = this.preferredLanguage;
    }
    const url = `${this.baseUrl}/v1/${operation}`;
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      [AUTH_HEADER]: this.partnerKey,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    for (;;) {
      let response: FetchResponse;
      try {
        response = await this.fetchFn(url, { method: "POST", headers, body: payload, signal: this.timeoutSignal() });
      } catch (err) {
        // Not retried: the request may already have reached the backend.
        throw new MindUploadConnectionError(
          `Could not reach the Mind Upload API for '${operation}': ${(err as Error).message}`,
          { operation },
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw new MindUploadConnectionError(
          `Failed to read the Mind Upload API response for '${operation}': ${(err as Error).message}`,
          { operation },
        );
      }
      let data: Result;
      try {
        data = text ? (JSON.parse(text) as Result) : ({ success: false } as Result);
      } catch {
        data = { success: false } as Result;
      }

      if (!response.ok) {
        if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
          attempt += 1;
          await sleep(backoffMs(attempt, response.headers.get("Retry-After")));
          continue;
        }
        throw this.errorFor(response.status, data, operation, response.headers.get("Retry-After"));
      }

      if (!data.success) {
        throw new MindUploadError(data.error_message || `${operation} failed`, { operation, response: data });
      }
      return data;
    }
  }

  private timeoutSignal(): unknown {
    const abortSignal = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal;
    return abortSignal && typeof abortSignal.timeout === "function" ? abortSignal.timeout(this.timeoutMs) : undefined;
  }

  private errorFor(status: number, data: Result, operation: string, retryAfterHeader: string | null): MindUploadError {
    const message = (data && (data.error_message as string)) || `HTTP ${status}`;
    if (status === 401) return new AuthenticationError(message, { status, operation, response: data });
    if (status === 429) {
      const parsed = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const retryAfter = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
      return new RateLimitError(message, { status, operation, response: data, retryAfter });
    }
    return new ApiError(message, { status, operation, response: data });
  }
}
