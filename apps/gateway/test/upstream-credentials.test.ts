import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createCredentialVault,
  credentialHeaders,
  decodeCredentialKey,
  generateCredentialKey,
  parseCredentialInput,
  parseCredentialPatch,
} from "../src/upstream-credentials.ts";

const KEY = Buffer.alloc(32, 9);
const OTHER_KEY = Buffer.alloc(32, 8);

describe("upstream credential vault (D34)", () => {
  test("encrypt/decrypt round-trips and binds the ciphertext to the upstream id (AAD)", () => {
    const vault = createCredentialVault(KEY);
    assert.ok(vault !== null);
    const cipher = vault.encrypt("super-secret-token", "acme");
    assert.equal(vault.decrypt(cipher, "acme"), "super-secret-token");
    // The same plaintext under a different id must not decrypt (AAD binding).
    assert.throws(() => vault.decrypt(cipher, "acme-2"), /could not be decrypted|malformed/);
  });

  test("wrong key cannot decrypt, and the error never echoes the plaintext", () => {
    const vault = createCredentialVault(KEY);
    const other = createCredentialVault(OTHER_KEY);
    assert.ok(vault !== null && other !== null);
    const cipher = vault.encrypt("hunter2-token", "acme");
    assert.throws(() => other.decrypt(cipher, "acme"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("hunter2"));
      return true;
    });
  });

  test("ciphertext never contains the plaintext bytes", () => {
    const vault = createCredentialVault(KEY);
    assert.ok(vault !== null);
    const cipher = vault.encrypt("plain-marker-value", "acme");
    assert.ok(!cipher.includes(Buffer.from("plain-marker-value", "utf8")));
    assert.ok(!cipher.toString("latin1").includes("plain-marker-value"));
  });

  test("malformed ciphertext (short buffer) fails closed", () => {
    const vault = createCredentialVault(KEY);
    assert.ok(vault !== null);
    assert.throws(() => vault.decrypt(Buffer.alloc(4), "acme"), /malformed/);
  });

  test("createCredentialVault(null or wrong-size key) returns null (no vault)", () => {
    assert.equal(createCredentialVault(null), null);
    assert.equal(createCredentialVault(Buffer.alloc(16)), null);
  });
});

describe("UPSTREAM_CREDENTIAL_KEY decoding", () => {
  test("valid base64 of exactly 32 bytes round-trips", () => {
    const encoded = generateCredentialKey();
    const result = decodeCredentialKey(encoded);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.key?.length, 32);
    }
  });

  test("absent or empty means no vault (ok with null key)", () => {
    for (const raw of [undefined, ""]) {
      const result = decodeCredentialKey(raw);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.key, null);
      }
    }
  });

  test("wrong length or non-base64 junk is rejected with a fixed message", () => {
    for (const raw of ["aGVsbG8=", "not base64 !!!", Buffer.alloc(31).toString("base64")]) {
      const result = decodeCredentialKey(raw);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /base64 of a 32-byte key/);
      }
    }
  });
});

describe("credential header derivation", () => {
  test("bearer becomes an Authorization header; header mode uses the named header", () => {
    assert.deepEqual(credentialHeaders({ mode: "bearer", value: "tok", headerName: null }), {
      authorization: "Bearer tok",
    });
    assert.deepEqual(credentialHeaders({ mode: "header", value: "tok", headerName: "x-api-key" }), {
      "x-api-key": "tok",
    });
  });
});

describe("admin credential input validation", () => {
  test("absent credential is valid and means none", () => {
    for (const raw of [undefined, null]) {
      const result = parseCredentialInput(raw);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.credential, null);
      }
    }
  });

  test("bearer requires mode+value and rejects a stray header field", () => {
    const ok = parseCredentialInput({ mode: "bearer", value: "tok" });
    assert.equal(ok.ok, true);
    const bad = parseCredentialInput({ mode: "bearer", value: "tok", header: "x-anything" });
    assert.equal(bad.ok, false);
  });

  test("header mode requires a valid header name", () => {
    const ok = parseCredentialInput({ mode: "header", value: "tok", header: "x-api-key" });
    assert.equal(ok.ok, true);
    const bad = parseCredentialInput({ mode: "header", value: "tok" });
    assert.equal(bad.ok, false);
    const badName = parseCredentialInput({ mode: "header", value: "tok", header: "bad header name!" });
    assert.equal(badName.ok, false);
  });

  test("value must be a non-empty string within the size cap", () => {
    assert.equal(parseCredentialInput({ mode: "bearer", value: "" }).ok, false);
    assert.equal(parseCredentialInput({ mode: "bearer", value: 123 }).ok, false);
    assert.equal(parseCredentialInput({ mode: "bearer", value: "x".repeat(5000) }).ok, false);
  });
});

describe("credential patch (three-state update semantics)", () => {
  test("omitted = unchanged, null = clear, object = set", () => {
    const unchanged = parseCredentialPatch(undefined);
    assert.equal(unchanged.ok && unchanged.patch.kind, "unchanged");
    const clear = parseCredentialPatch(null);
    assert.equal(clear.ok && clear.patch.kind, "clear");
    const set = parseCredentialPatch({ mode: "bearer", value: "new-tok" });
    assert.equal(set.ok && set.patch.kind, "set");
  });

  test("a malformed patch object is rejected", () => {
    assert.equal(parseCredentialPatch({ mode: "bearer" }).ok, false);
    assert.equal(parseCredentialPatch("nope").ok, false);
  });
});
