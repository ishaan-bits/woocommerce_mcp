import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  dummyCompare,
  generateApiKey,
  hashApiKey,
  hashesMatch,
  keyPrefixOf,
  KEY_ALGORITHM_PREFIX,
  KEY_PREFIX_LENGTH,
  KEY_RANDOM_BYTES,
  looksLikeApiKey,
} from "../src/auth/keys.ts";

const PEPPER = "unit-test-pepper-not-a-secret";

describe("API key generation and hashing (D8/C1)", () => {
  test("keys are umk_-prefixed base64url of 32 random bytes with a 12-char prefix", () => {
    const generated = generateApiKey(PEPPER);
    assert.ok(generated.key.startsWith(KEY_ALGORITHM_PREFIX));
    const body = generated.key.slice(KEY_ALGORITHM_PREFIX.length);
    assert.equal(body.length, 43);
    assert.match(body, /^[A-Za-z0-9_-]+$/);
    assert.equal(KEY_RANDOM_BYTES, 32);
    assert.equal(generated.keyPrefix, generated.key.slice(0, KEY_PREFIX_LENGTH));
    assert.equal(generated.keyPrefix.length, KEY_PREFIX_LENGTH);
    assert.match(generated.keyHash, /^[0-9a-f]{64}$/);
  });

  test("two keys are never equal (CSPRNG randomness)", () => {
    const first = generateApiKey(PEPPER);
    const second = generateApiKey(PEPPER);
    assert.notEqual(first.key, second.key);
    assert.notEqual(first.keyPrefix, second.keyPrefix);
  });

  test("the stored hash is sha256(key || pepper): pepper change breaks verification", () => {
    const generated = generateApiKey(PEPPER);
    assert.equal(generated.keyHash, hashApiKey(generated.key, PEPPER));
    assert.notEqual(generated.keyHash, hashApiKey(generated.key, `${PEPPER}x`));
    assert.notEqual(generated.keyHash, hashApiKey(`x${generated.key}`, PEPPER));
    // The pepper is not recoverable from the digest.
    assert.ok(!generated.keyHash.includes(PEPPER));
  });

  test("looksLikeApiKey keeps garbage out of the database", () => {
    const valid = generateApiKey(PEPPER).key;
    assert.equal(looksLikeApiKey(valid), true);
    assert.equal(looksLikeApiKey(`umk_${"a".repeat(43)}`), true);
    assert.equal(looksLikeApiKey(""), false);
    assert.equal(looksLikeApiKey("Bearer abc"), false);
    assert.equal(looksLikeApiKey(`umk_${"a".repeat(42)}`), false);
    assert.equal(looksLikeApiKey(`umk_${"a".repeat(44)}`), false);
    assert.equal(looksLikeApiKey(`umk_${"a".repeat(42)}!`), false);
    assert.equal(looksLikeApiKey(`sk_live_${"a".repeat(43)}`), false);
  });

  test("keyPrefixOf returns the public 12-character lookup prefix", () => {
    const generated = generateApiKey(PEPPER);
    assert.equal(keyPrefixOf(generated.key), generated.keyPrefix);
    assert.equal(generated.key.startsWith(keyPrefixOf(generated.key)), true);
  });

  test("hashesMatch is strict about digest shape and fails closed", () => {
    const generated = generateApiKey(PEPPER);
    assert.equal(hashesMatch(generated.keyHash, generated.keyHash), true);
    assert.equal(hashesMatch(generated.keyHash, hashApiKey(`${generated.key}!`, PEPPER)), false);
    // Malformed stored digests must never throw or match.
    assert.equal(hashesMatch(generated.keyHash, ""), false);
    assert.equal(hashesMatch(generated.keyHash, "abc"), false);
    assert.equal(hashesMatch("abc", generated.keyHash), false);
    assert.equal(hashesMatch(generated.keyHash, "z".repeat(64)), false);
    assert.equal(hashesMatch(generated.keyHash, generated.keyHash.slice(1)), false);
  });

  test("dummyCompare performs the equal-time no-row comparison without throwing", () => {
    const generated = generateApiKey(PEPPER);
    assert.doesNotThrow(() => dummyCompare(generated.keyHash));
    assert.doesNotThrow(() => dummyCompare(""));
    assert.doesNotThrow(() => dummyCompare("not-a-hash"));
  });
});
