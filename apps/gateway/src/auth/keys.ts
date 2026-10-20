import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys follow D8/C1: >= 32 bytes of CSPRNG randomness, shown to the user
 * exactly once, stored only as sha256(key || pepper) plus a non-secret prefix.
 *
 * Key format: `umk_` + base64url(randomBytes(32))  (~51 characters, 256 bits)
 * Prefix:     first KEY_PREFIX_LENGTH characters of the key (public, display/lookup)
 */

export const KEY_ALGORITHM_PREFIX = "umk_";
export const KEY_RANDOM_BYTES = 32;
export const KEY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** Plaintext key. Returned to the caller exactly once and never persisted. */
  readonly key: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
}

export function generateApiKey(pepper: string): GeneratedApiKey {
  const key = `${KEY_ALGORITHM_PREFIX}${randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;
  return {
    key,
    keyPrefix: key.slice(0, KEY_PREFIX_LENGTH),
    keyHash: hashApiKey(key, pepper),
  };
}

export function hashApiKey(key: string, pepper: string): string {
  return createHash("sha256").update(key, "utf8").update(pepper, "utf8").digest("hex");
}

/** Structural check before any lookup: keeps garbage out of the database. */
export function looksLikeApiKey(key: string): boolean {
  if (!key.startsWith(KEY_ALGORITHM_PREFIX)) {
    return false;
  }
  const body = key.slice(KEY_ALGORITHM_PREFIX.length);
  // base64url of 32 bytes is exactly 43 characters.
  return body.length === 43 && /^[A-Za-z0-9_-]+$/.test(body);
}

export function keyPrefixOf(key: string): string {
  return key.slice(0, KEY_PREFIX_LENGTH);
}

/**
 * Constant-time comparison of two hex sha256 digests (64 hex chars each).
 * Returns false instead of throwing on unexpected input lengths so callers
 * fail closed.
 */
export function hashesMatch(computed: string, stored: string): boolean {
  if (computed.length !== 64 || stored.length !== 64 || !/^[0-9a-f]+$/.test(stored)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(computed, "utf8"), Buffer.from(stored, "utf8"));
}

/**
 * Timing-equalized "no row found" path: performs one comparison against
 * random bytes so an unknown prefix takes the same work as a hash mismatch.
 */
export function dummyCompare(computed: string): void {
  const left = Buffer.alloc(64);
  Buffer.from(computed, "utf8").copy(left);
  timingSafeEqual(left, randomBytes(64));
}
