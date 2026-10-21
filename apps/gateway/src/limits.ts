import { GatewayError } from "./errors.ts";

export interface TokenBucketLimiterOptions {
  /** Maximum tokens (burst size). */
  capacity: number;
  /** Sustained refill rate. */
  refillPerMinute: number;
  now?: () => number;
  /** Cap on tracked keys; oldest entries are evicted past the limit. */
  maxKeys?: number;
}

export interface TokenBucketLimiter {
  /** Consumes one token; false when the key is currently limited. */
  tryTake(key: string): boolean;
  /** Clears state for a key (e.g. after a successful login). */
  reset(key: string): void;
}

interface Bucket {
  tokens: number;
  lastMs: number;
}

export const DEFAULT_RATE_LIMITER_MAX_KEYS = 100_000;

export function createTokenBucketLimiter(options: TokenBucketLimiterOptions): TokenBucketLimiter {
  const capacity = Math.max(1, options.capacity);
  const refillPerMinute = Math.max(0, options.refillPerMinute);
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? DEFAULT_RATE_LIMITER_MAX_KEYS;
  const buckets = new Map<string, Bucket>();

  function evictIfNeeded(): void {
    if (buckets.size < maxKeys) {
      return;
    }
    // Map preserves insertion order: drop the oldest quarter first, and always
    // drop full buckets (they hold no limiting state) before active ones.
    let toDelete = Math.ceil(maxKeys / 4);
    for (const [key, bucket] of buckets) {
      if (toDelete <= 0) {
        break;
      }
      if (bucket.tokens >= capacity) {
        buckets.delete(key);
        toDelete -= 1;
      }
    }
    for (const [key] of buckets) {
      if (toDelete <= 0) {
        break;
      }
      buckets.delete(key);
      toDelete -= 1;
    }
  }

  function refill(bucket: Bucket, at: number): void {
    const elapsedMs = Math.max(0, at - bucket.lastMs);
    if (elapsedMs === 0) {
      return;
    }
    const gained = (elapsedMs * refillPerMinute) / 60_000;
    bucket.tokens = Math.min(capacity, bucket.tokens + gained);
    bucket.lastMs = at;
  }

  return {
    tryTake(key) {
      const at = now();
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        evictIfNeeded();
        bucket = { tokens: capacity, lastMs: at };
        buckets.set(key, bucket);
      }
      refill(bucket, at);
      if (refillPerMinute === 0) {
        return true;
      }
      if (bucket.tokens < 1) {
        return false;
      }
      bucket.tokens -= 1;
      return true;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}

export interface Semaphore {
  /** Resolves to a release function, or rejects with GatewayError("busy"). */
  acquire(timeoutMs: number): Promise<() => void>;
}

export function createSemaphore(limit: number): Semaphore {
  const size = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiters: Array<{ resolve: (release: () => void) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }> = [];

  function release(): void {
    const next = waiters.shift();
    if (next !== undefined) {
      clearTimeout(next.timer);
      next.resolve(release);
      return;
    }
    active -= 1;
  }

  return {
    acquire(timeoutMs) {
      if (active < size) {
        active += 1;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(
            new GatewayError(
              "busy",
              `too many concurrent calls to this upstream (limit ${size}); retry shortly`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiters.push({ resolve, reject, timer });
      });
    },
  };
}
