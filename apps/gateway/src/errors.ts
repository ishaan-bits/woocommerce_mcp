export type GatewayErrorCode =
  | "unknown_tool"
  | "upstream_disabled"
  | "timeout"
  | "connect_timeout"
  | "connection"
  | "blocked_private_address"
  | "response_too_large"
  | "busy"
  | "upstream_error";

export interface GatewayErrorOptions {
  upstreamId?: string;
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

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly upstreamId: string | undefined;

  constructor(code: GatewayErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "GatewayError";
    this.code = code;
    this.upstreamId = options.upstreamId;
  }
}

export class ArgumentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Input validation error: ${issues.join("; ")}`);
    this.name = "ArgumentValidationError";
    this.issues = issues;
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}
