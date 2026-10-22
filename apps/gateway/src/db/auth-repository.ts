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

/** Admin-facing user metadata (Team page): identity, grants, key counts. */
export interface UserAdminRecord {
  readonly id: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly allowedUpstreams: readonly UpstreamId[];
  readonly allowedTools: readonly string[];
  readonly createdAt: string;
  /** API keys currently usable (revoked_at IS NULL). */
  readonly activeKeys: number;
  readonly totalKeys: number;
}

export interface CreateUserInput {
  readonly displayName: string;
  readonly role: UserRole;
  readonly allowedUpstreams: readonly UpstreamId[];
  readonly allowedTools: readonly string[];
}

export interface UpdateUserInput {
  readonly displayName?: string;
  readonly role?: UserRole;
  readonly allowedUpstreams?: readonly UpstreamId[];
  readonly allowedTools?: readonly string[];
}

/** Raised when a display_name collides with an existing user (UNIQUE constraint). */
export class UserConflictError extends Error {
  constructor(displayName: string) {
    super(`display name already in use: ${displayName}`);
    this.name = "UserConflictError";
  }
}

/**
 * Auth data access. The production implementation talks to PostgreSQL; unit
 * tests substitute an in-memory fake with the same contract (D7: the real
 * store is PostgreSQL, never SQLite/JSON — integration tests prove it).
 */
export interface AuthRepository {
  /** All keys sharing this non-secret prefix (normally exactly one). */
  findByPrefix(keyPrefix: string): Promise<StoredApiKey[]>;
  /** Key lookup by id — used by dashboard session verification (D23). */
  findKeyById(keyId: string): Promise<StoredApiKey | null>;
  createKey(userId: string, keyPrefix: string, keyHash: string): Promise<CreateKeyResult>;
  /** Flips revoked_at only when it is still NULL; row is kept (C1). */
  revokeKey(keyId: string): Promise<{ found: boolean; revokedNow: boolean; revokedAt: string | null }>;
  listKeys(): Promise<KeyMetadata[]>;
  userExists(userId: string): Promise<boolean>;
  /** Admin-only member listing (display names, grants, key counts — no hashes). */
  listUsers(): Promise<UserAdminRecord[]>;
  /** Creates a member; rejects duplicate display names (`conflict`). */
  createUser(input: CreateUserInput): Promise<UserAdminRecord>;
  /** Partial update of role/grants/display name; `null` when the id is unknown. */
  updateUser(userId: string, patch: UpdateUserInput): Promise<UserAdminRecord | null>;
}
