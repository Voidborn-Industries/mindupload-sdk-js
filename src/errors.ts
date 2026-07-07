import type { Result } from "./client";

export interface ErrorOptions {
  operation?: string;
  response?: Result;
}
export interface ApiErrorOptions extends ErrorOptions {
  status: number;
}
export interface RateLimitOptions extends ApiErrorOptions {
  retryAfter?: number;
}

/** Base class for every Mind Upload error — one `catch` handles them all. */
export class MindUploadError extends Error {
  readonly operation?: string;
  readonly response?: Result;
  constructor(message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = "MindUploadError";
    this.operation = options.operation;
    this.response = options.response;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The API returned an error HTTP status (or an unexpected response). */
export class ApiError extends MindUploadError {
  readonly status: number;
  constructor(message: string, options: ApiErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.status = options.status;
  }
}

/** The partner key was missing, malformed, or rejected (HTTP 401). */
export class AuthenticationError extends ApiError {
  constructor(message: string, options: ApiErrorOptions) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

/** A rate limit or credit cap was hit (HTTP 429). */
export class RateLimitError extends ApiError {
  /** Server-advised wait in seconds, when provided. */
  readonly retryAfter?: number;
  constructor(message: string, options: RateLimitOptions) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfter = options.retryAfter;
  }
}

/** The API could not be reached (DNS, TLS, timeout, or network failure). */
export class MindUploadConnectionError extends MindUploadError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "MindUploadConnectionError";
  }
}
