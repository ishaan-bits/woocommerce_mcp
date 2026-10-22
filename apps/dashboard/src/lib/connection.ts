/**
 * Session expiry + gateway-connection tracking for the topbar.
 *
 * - `trackApi` wraps the client so every authenticated call records the last
 *   successful timestamp (the topbar "connected" pill is derived from real
 *   API success, never a fake health probe — /healthz is not proxied).
 * - Only genuine connectivity trouble (network failures, gateway 5xx) marks
 *   the gateway unreachable. An LLM-provider rate limit or outage reported
 *   by a healthy gateway keeps the pill "Connected" — provider availability
 *   is shown in the chat banner instead, never conflated with gateway health.
 * - Any 401 (UnauthorizedError) from a tracked call flips the app back to
 *   the login screen with a "session expired" note.
 *
 * Pure logic lives in `connectionStatus` (unit-tested); this module only
 * wires listeners and thin adapters.
 */

import type { ApiClient } from "../api/client.ts";
import { ApiError, UnauthorizedError } from "../api/client.ts";

export interface ConnectionState {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

type Listener = () => void;

let state: ConnectionState = { lastSuccessAt: null, lastFailureAt: null };
const listeners = new Set<Listener>();
let unauthorizedHandler: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function getConnectionState(): ConnectionState {
  return state;
}

export function subscribeConnection(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset; the UI never calls this. */
export function resetConnection(): void {
  state = { lastSuccessAt: null, lastFailureAt: null };
  unauthorizedHandler = null;
  emit();
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function noteApiSuccess(now: number = Date.now()): void {
  state = { lastSuccessAt: now, lastFailureAt: state.lastFailureAt };
  emit();
}

export function noteApiFailure(now: number = Date.now()): void {
  state = { lastSuccessAt: state.lastSuccessAt, lastFailureAt: now };
  emit();
}

/** Pure: derive the pill from the last real API outcomes. */
export function connectionStatus(
  state: ConnectionState,
  now: number,
): { tone: "success" | "warn" | "neutral"; label: string } {
  const { lastSuccessAt, lastFailureAt } = state;
  if (lastSuccessAt === null && lastFailureAt === null) {
    return { tone: "neutral", label: "Gateway status unknown" };
  }
  const successIsLatest = lastSuccessAt !== null && (lastFailureAt === null || lastSuccessAt >= lastFailureAt);
  if (successIsLatest) {
    return { tone: "success", label: `Connected · last call ${formatClock(lastSuccessAt)}` };
  }
  return { tone: "warn", label: "Gateway unreachable — last call failed" };
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}

/**
 * Codes that mean "the gateway answered; something beyond it is unavailable"
 * (LLM provider busy/timeout/down, agent not configured). These say nothing
 * about gateway connectivity — the pill must not claim "unreachable" for them.
 */
const PROVIDER_SIDE_CODES = new Set([
  "provider_rate_limited",
  "provider_timeout",
  "provider_error",
  "agent_not_configured",
]);

/**
 * True when the call failed DESPITE a healthy gateway (an application-level
 * answer, typically provider availability). False for real connectivity
 * trouble: network failures (`gateway_unreachable`, status 0) and gateway
 * server errors (5xx `internal_error` and friends).
 */
function isGatewayStillReachable(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  if (error.code === "gateway_unreachable") {
    return false;
  }
  return PROVIDER_SIDE_CODES.has(error.code) || error.status < 500;
}

/** Wrap a client so successes/failures feed the pill and 401s expire the session. */
export function trackApi(api: ApiClient): ApiClient {
  const wrap = <T,>(promise: Promise<T>): Promise<T> =>
    promise.then(
      (value) => {
        noteApiSuccess();
        return value;
      },
      (error: unknown) => {
        if (error instanceof UnauthorizedError) {
          unauthorizedHandler?.();
        } else if (!isAbort(error) && !isGatewayStillReachable(error)) {
          // A user-initiated Stop/abort is not a gateway failure. Neither is
          // an LLM-provider rate limit or outage reported by a healthy
          // gateway — provider availability is a separate concern from
          // gateway connectivity (the chat banner shows provider errors).
          noteApiFailure();
        }
        throw error;
      },
    );

  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result instanceof Promise) return wrap(result);
          return result;
        };
      }
      return value;
    },
  });
}
