import type { UpstreamId, UserRole } from "@mcp/shared";

export interface StoredUser {
  readonly id: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly allowedUpstreams: readonly UpstreamId[];
  /** ToolPermission strings: `tools:<qualifiedName>` (C5). */
  readonly allowedTools: readonly string[];
}

export interface StoredApiKey {
  readonly id: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly revokedAt: string | null;
  readonly user: StoredUser;
}

export interface KeyMetadata {
  readonly id: string;
  readonly keyPrefix: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface CreateKeyResult {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * Auth data access. The production implementation talks to PostgreSQL; unit
 * tests substitute an in-memory fake with the same contract (D7: the real
 * store is PostgreSQL, never SQLite/JSON — integration tests prove it).
 */
export interface AuthRepository {
  /** All keys sharing this non-secret prefix (normally exactly one). */
  findByPrefix(keyPrefix: string): Promise<StoredApiKey[]>;
  createKey(userId: string, keyPrefix: string, keyHash: string): Promise<CreateKeyResult>;
  /** Flips revoked_at only when it is still NULL; row is kept (C1). */
  revokeKey(keyId: string): Promise<{ found: boolean; revokedNow: boolean; revokedAt: string | null }>;
  listKeys(): Promise<KeyMetadata[]>;
  userExists(userId: string): Promise<boolean>;
}
