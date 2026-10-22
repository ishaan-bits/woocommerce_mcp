import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Static upstream credentials entered by an admin (PDF §Gateway: "optional
 * static credential (header or bearer token)").
 *
 * Threat-model C3 for dynamic servers: the PLAINTEXT credential exists only
 * in memory (to be sent on the wire) and in this module's encrypt/decrypt
 * boundary — the database stores AES-256-GCM ciphertext only, logs and API
 * responses never carry it, and the dashboard only ever sees a
 * has-credential boolean. The key comes from UPSTREAM_CREDENTIAL_KEY (a
 * Kubernetes Secret in production) and never appears in code or values files.
 */

export type UpstreamCredentialMode = "bearer" | "header";

export interface UpstreamCredential {
  readonly mode: UpstreamCredentialMode;
  /** Secret material. Never logged, never serialized to a response. */
  readonly value: string;
  /** Custom header name for mode "header"; null for "bearer". */
  readonly headerName: string | null;
}

export interface CredentialVault {
  /** Presence only — never the key material itself. */
  readonly keyPresent: boolean;
  encrypt(plaintext: string, upstreamId: string): Buffer;
  decrypt(cipher: Buffer, upstreamId: string): string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_CREDENTIAL_CHARS = 4_096;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type DecodeKeyResult = { ok: true; key: Buffer | null } | { ok: false; error: string };

/**
 * Decode UPSTREAM_CREDENTIAL_KEY: base64 of exactly 32 bytes. Absent/empty
 * means "no vault" (creating a credential then fails closed; boot refuses to
 * start if encrypted rows already exist).
 */
export function decodeCredentialKey(raw: string | undefined): DecodeKeyResult {
  const value = (raw ?? "").trim();
  if (value === "") {
    return { ok: true, key: null };
  }
  const normalized = value.replace(/=+$/, "");
  const key = Buffer.from(normalized, "base64");
  // Buffer.from never throws on junk, so reject anything that does not
  // round-trip as base64 of exactly 32 bytes.
  if (key.length !== KEY_BYTES || key.toString("base64").replace(/=+$/, "") !== normalized) {
    return { ok: false, error: "UPSTREAM_CREDENTIAL_KEY must be base64 of a 32-byte key" };
  }
  return { ok: true, key };
}

/** Build a random 32-byte key, base64-encoded (for tests / key generation docs). */
export function generateCredentialKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function createCredentialVault(key: Buffer | null): CredentialVault | null {
  if (key === null || key.length !== KEY_BYTES) {
    return null;
  }
  return {
    keyPresent: true,
    encrypt(plaintext: string, upstreamId: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(upstreamId, "utf8"));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, encrypted]);
    },
    decrypt(cipher: Buffer, upstreamId: string): string {
      if (cipher.length < IV_BYTES + TAG_BYTES) {
        throw new Error("upstream credential ciphertext is malformed");
      }
      const iv = cipher.subarray(0, IV_BYTES);
      const tag = cipher.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const encrypted = cipher.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(upstreamId, "utf8"));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      } catch {
        // Wrong key or tampered row: fail closed with a non-sensitive message.
        throw new Error("upstream credential could not be decrypted (wrong UPSTREAM_CREDENTIAL_KEY?)");
      }
    },
  };
}

/** Wire headers for one credential — the ONLY place plaintext becomes a header. */
export function credentialHeaders(credential: UpstreamCredential): Record<string, string> {
  if (credential.mode === "header") {
    return { [credential.headerName ?? "x-api-key"]: credential.value };
  }
  return { authorization: `Bearer ${credential.value}` };
}

export type CredentialInputResult =
  | { ok: true; credential: UpstreamCredential | null }
  | { ok: false; error: string };

/** Validate an admin-supplied credential object from a request body. */
export function parseCredentialInput(raw: unknown): CredentialInputResult {
  if (raw === null || raw === undefined) {
    return { ok: true, credential: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "credential must be an object with mode and value" };
  }
  const body = raw as { mode?: unknown; value?: unknown; header?: unknown };
  if (body.mode !== "bearer" && body.mode !== "header") {
    return { ok: false, error: 'credential.mode must be "bearer" or "header"' };
  }
  if (typeof body.value !== "string" || body.value.length === 0 || body.value.length > MAX_CREDENTIAL_CHARS) {
    return { ok: false, error: `credential.value must be a non-empty string of at most ${MAX_CREDENTIAL_CHARS} characters` };
  }
  if (body.mode === "header") {
    if (typeof body.header !== "string" || !HEADER_NAME_PATTERN.test(body.header)) {
      return { ok: false, error: "credential.header must be a header name (letters, digits, dashes; max 64)" };
    }
    return { ok: true, credential: { mode: "header", value: body.value, headerName: body.header } };
  }
  if (body.header !== undefined && body.header !== null) {
    return { ok: false, error: "credential.header is only valid when credential.mode is header" };
  }
  return { ok: true, credential: { mode: "bearer", value: body.value, headerName: null } };
}

export type CredentialPatch =
  /** Field absent: keep the stored credential unchanged. */
  | { kind: "unchanged" }
  /** Explicit null: remove any stored credential. */
  | { kind: "clear" }
  /** A validated credential object: replace. */
  | { kind: "set"; credential: UpstreamCredential };

export type CredentialPatchResult =
  | { ok: true; patch: CredentialPatch }
  | { ok: false; error: string };

/**
 * Three-state patch semantics for updates: omitted field keeps the existing
 * credential, `credential: null` removes it, an object replaces it.
 */
export function parseCredentialPatch(raw: unknown): CredentialPatchResult {
  if (raw === undefined) {
    return { ok: true, patch: { kind: "unchanged" } };
  }
  if (raw === null) {
    return { ok: true, patch: { kind: "clear" } };
  }
  const parsed = parseCredentialInput(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.credential === null) {
    return { ok: false, error: "credential must be an object with mode and value" };
  }
  return { ok: true, patch: { kind: "set", credential: parsed.credential } };
}
