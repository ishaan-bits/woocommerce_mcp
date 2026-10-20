export type UpstreamErrorCode =
  | "timeout"
  | "connection"
  | "http"
  | "not_found"
  | "malformed_response";

export interface UpstreamErrorDetails {
  status?: number;
  wooCode?: string;
  method?: string;
  path?: string;
}

export interface UpstreamErrorOptions {
  details?: UpstreamErrorDetails;
  cause?: unknown;
}

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly details: UpstreamErrorDetails;

  constructor(code: UpstreamErrorCode, message: string, options: UpstreamErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "UpstreamError";
    this.code = code;
    this.details = options.details ?? {};
  }
}

export function isUpstreamError(error: unknown): error is UpstreamError {
  return error instanceof UpstreamError;
}

export function isNotFound(error: unknown): boolean {
  return isUpstreamError(error) && error.code === "not_found";
}
