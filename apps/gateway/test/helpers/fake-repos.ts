import { randomUUID } from "node:crypto";
import type { AuditLogEntry, UpstreamId, UserRole } from "@mcp/shared";
import type { AuditRepository, NewAuditEntry } from "../../src/db/audit-repository.ts";
import type {
  AuthRepository,
  CreateKeyResult,
  KeyMetadata,
  StoredApiKey,
  StoredUser,
} from "../../src/db/auth-repository.ts";
import { generateApiKey } from "../../src/auth/keys.ts";

/**
 * In-memory stand-ins with the exact repository contracts.
 *
 * These exist ONLY for unit tests. The production implementation is
 * PostgreSQL (D7) and `test/integration/postgres.test.ts` proves the real one;
 * `down = true` simulates a database outage for fail-closed tests.
 */

interface FakeKeyRow {
  id: string;
  keyPrefix: string;
  keyHash: string;
  revokedAt: string | null;
  user: StoredUser;
}

export class FakeAuthRepository implements AuthRepository {
  private readonly byPrefix = new Map<string, FakeKeyRow[]>();
  private readonly users = new Map<string, StoredUser>();
  down = false;

  seedUser(user: StoredUser): void {
    this.users.set(user.id, user);
  }

  /** Test convenience: mint a key the way the REST API does (hash stored, plaintext returned). */
  issueKey(userId: string, pepper: string): { key: string; keyId: string; keyPrefix: string } {
    const user = this.users.get(userId);
    if (user === undefined) {
      throw new Error(`unknown user ${userId}`);
    }
    const generated = generateApiKey(pepper);
    const keyId = randomUUID();
    const row: FakeKeyRow = {
      id: keyId,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      revokedAt: null,
      user,
    };
    const rows = this.byPrefix.get(generated.keyPrefix) ?? [];
    rows.push(row);
    this.byPrefix.set(generated.keyPrefix, rows);
    return { key: generated.key, keyId, keyPrefix: generated.keyPrefix };
  }

  revokeByKeyId(keyId: string): boolean {
    for (const rows of this.byPrefix.values()) {
      for (const row of rows) {
        if (row.id === keyId && row.revokedAt === null) {
          row.revokedAt = new Date().toISOString();
          return true;
        }
      }
    }
    return false;
  }

  private guard(): void {
    if (this.down) {
      throw new Error("fake database is down (ECONNREFUSED 127.0.0.1:5432)");
    }
  }

  async findByPrefix(keyPrefix: string): Promise<StoredApiKey[]> {
    this.guard();
    return [...(this.byPrefix.get(keyPrefix) ?? [])];
  }

  async createKey(userId: string, keyPrefix: string, keyHash: string): Promise<CreateKeyResult> {
    this.guard();
    const user = this.users.get(userId);
    if (user === undefined) {
      throw new Error("violates foreign key constraint (fake): api_keys_user_id_fkey");
    }
    const keyId = randomUUID();
    const row: FakeKeyRow = { id: keyId, keyPrefix, keyHash, revokedAt: null, user };
    const rows = this.byPrefix.get(keyPrefix) ?? [];
    rows.push(row);
    this.byPrefix.set(keyPrefix, rows);
    return { id: keyId, createdAt: new Date().toISOString() };
  }

  async revokeKey(keyId: string): Promise<{ found: boolean; revokedNow: boolean; revokedAt: string | null }> {
    this.guard();
    for (const rows of this.byPrefix.values()) {
      for (const row of rows) {
        if (row.id === keyId) {
          if (row.revokedAt !== null) {
            return { found: true, revokedNow: false, revokedAt: row.revokedAt };
          }
          const at = new Date().toISOString();
          row.revokedAt = at;
          return { found: true, revokedNow: true, revokedAt: at };
        }
      }
    }
    return { found: false, revokedNow: false, revokedAt: null };
  }

  async listKeys(): Promise<KeyMetadata[]> {
    this.guard();
    const out: KeyMetadata[] = [];
    for (const rows of this.byPrefix.values()) {
      for (const row of rows) {
        out.push({
          id: row.id,
          keyPrefix: row.keyPrefix,
          userId: row.user.id,
          displayName: row.user.displayName,
          role: row.user.role,
          createdAt: new Date().toISOString(),
          revokedAt: row.revokedAt,
        });
      }
    }
    return out;
  }

  async userExists(userId: string): Promise<boolean> {
    this.guard();
    return this.users.has(userId);
  }
}

export class FakeAuditRepository implements AuditRepository {
  readonly entries: Array<AuditLogEntry & { raw: NewAuditEntry }> = [];
  down = false;
  private sequence = 0;

  private guard(): void {
    if (this.down) {
      throw new Error("fake audit store is down (ECONNREFUSED 127.0.0.1:5432)");
    }
  }

  async append(entry: NewAuditEntry): Promise<void> {
    this.guard();
    this.sequence += 1;
    this.entries.push({
      id: String(this.sequence),
      occurredAt: new Date().toISOString(),
      action: entry.action,
      keyId: entry.keyId,
      userId: entry.userId,
      role: entry.role as UserRole | null,
      upstreamId: entry.upstreamId as UpstreamId | null,
      toolName: entry.toolName,
      qualifiedName: entry.qualifiedName,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
      errorCode: entry.errorCode,
      raw: entry,
    });
  }

  async recent(limit: number, beforeId?: string): Promise<AuditLogEntry[]> {
    this.guard();
    const before = beforeId === undefined ? Number.MAX_SAFE_INTEGER : Number(beforeId);
    return this.entries
      .filter((entry) => Number(entry.id) < before)
      .slice(-limit)
      .reverse()
      .map(({ raw: _raw, ...entry }) => entry);
  }

  /** Test convenience: rows matching an action, newest first. */
  byAction(action: AuditLogEntry["action"]): AuditLogEntry[] {
    return this.entries.filter((entry) => entry.action === action).map(({ raw: _raw, ...entry }) => entry);
  }
}
