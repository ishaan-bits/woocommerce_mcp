import { randomUUID } from "node:crypto";
import { type AggregatedTool, type AuditLogEntry, type UpstreamConfig, type UpstreamHealth, type UserRole } from "@mcp/shared";
import type { AuditFilters, AuditRepository, NewAuditEntry, UpstreamToolStats } from "../../src/db/audit-repository.ts";
import type {
  AuthRepository,
  CreateKeyResult,
  CreateUserInput,
  KeyMetadata,
  StoredApiKey,
  StoredUser,
  UpdateUserInput,
  UserAdminRecord,
} from "../../src/db/auth-repository.ts";
import { UserConflictError } from "../../src/db/auth-repository.ts";
import {
  DuplicateUpstreamUrlError,
  type DynamicUpstreamRecord,
  type DynamicUpstreamRepository,
  type DynamicUpstreamWrite,
} from "../../src/db/dynamic-upstream-repository.ts";
import type { SessionRepository, StoredSession } from "../../src/db/session-repository.ts";
import type { UpstreamStateRepository } from "../../src/db/upstream-state-repository.ts";
import type { UpstreamRegistry } from "../../src/upstream-registry.ts";
import type { UpstreamCredential } from "../../src/upstream-credentials.ts";
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
    // Resolve the user LIVE (like the PostgreSQL JOIN in verify), so a
    // grant/role update applies to already-issued keys immediately.
    return [...(this.byPrefix.get(keyPrefix) ?? [])].map((row) => ({
      ...row,
      user: this.users.get(row.user.id) ?? row.user,
    }));
  }

  async findKeyById(keyId: string): Promise<StoredApiKey | null> {
    this.guard();
    for (const rows of this.byPrefix.values()) {
      for (const row of rows) {
        if (row.id === keyId) {
          return { ...row, user: this.users.get(row.user.id) ?? row.user };
        }
      }
    }
    return null;
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

  async listKeysForUser(userId: string): Promise<KeyMetadata[]> {
    return (await this.listKeys()).filter((key) => key.userId === userId);
  }

  async userExists(userId: string): Promise<boolean> {
    this.guard();
    return this.users.has(userId);
  }

  async listUsers(): Promise<UserAdminRecord[]> {
    this.guard();
    return [...this.users.values()]
      .map((user) => ({
        ...user,
        allowedUpstreams: [...user.allowedUpstreams],
        allowedTools: [...user.allowedTools],
        createdAt: new Date().toISOString(),
        activeKeys: this.keyCount(user.id, false),
        totalKeys: this.keyCount(user.id, true),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async createUser(input: CreateUserInput): Promise<UserAdminRecord> {
    this.guard();
    for (const existing of this.users.values()) {
      if (existing.displayName === input.displayName) {
        throw new UserConflictError(input.displayName);
      }
    }
    const user: StoredUser = {
      id: randomUUID(),
      displayName: input.displayName,
      role: input.role,
      allowedUpstreams: [...input.allowedUpstreams],
      allowedTools: [...input.allowedTools],
    };
    this.users.set(user.id, user);
    return {
      ...user,
      allowedUpstreams: [...user.allowedUpstreams],
      allowedTools: [...user.allowedTools],
      createdAt: new Date().toISOString(),
      activeKeys: 0,
      totalKeys: 0,
    };
  }

  async updateUser(userId: string, patch: UpdateUserInput): Promise<UserAdminRecord | null> {
    this.guard();
    const existing = this.users.get(userId);
    if (existing === undefined) {
      return null;
    }
    if (patch.displayName !== undefined) {
      for (const [otherId, other] of this.users) {
        if (otherId !== userId && other.displayName === patch.displayName) {
          throw new UserConflictError(patch.displayName);
        }
      }
    }
    const updated: StoredUser = {
      ...existing,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.allowedUpstreams !== undefined ? { allowedUpstreams: [...patch.allowedUpstreams] } : {}),
      ...(patch.allowedTools !== undefined ? { allowedTools: [...patch.allowedTools] } : {}),
    };
    this.users.set(userId, updated);
    return {
      ...updated,
      allowedUpstreams: [...updated.allowedUpstreams],
      allowedTools: [...updated.allowedTools],
      createdAt: new Date().toISOString(),
      activeKeys: this.keyCount(userId, false),
      totalKeys: this.keyCount(userId, true),
    };
  }

  private keyCount(userId: string, includeRevoked: boolean): number {
    let count = 0;
    for (const rows of this.byPrefix.values()) {
      for (const row of rows) {
        if (row.user.id === userId && (includeRevoked || row.revokedAt === null)) {
          count += 1;
        }
      }
    }
    return count;
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
      upstreamId: entry.upstreamId,
      toolName: entry.toolName,
      qualifiedName: entry.qualifiedName,
      outcome: entry.outcome,
      durationMs: entry.durationMs,
      errorCode: entry.errorCode,
      raw: entry,
    });
  }

  async recent(limit: number, beforeId?: string, filters?: AuditFilters): Promise<AuditLogEntry[]> {
    this.guard();
    const before = beforeId === undefined ? Number.MAX_SAFE_INTEGER : Number(beforeId);
    const matches = (entry: AuditLogEntry): boolean => {
      if (filters?.action !== undefined && entry.action !== filters.action) return false;
      if (filters?.outcome !== undefined && entry.outcome !== filters.outcome) return false;
      if (filters?.userId !== undefined && entry.userId !== filters.userId) return false;
      if (filters?.upstreamId !== undefined && entry.upstreamId !== filters.upstreamId) return false;
      if (
        filters?.tool !== undefined &&
        (entry.qualifiedName === null || !entry.qualifiedName.toLowerCase().includes(filters.tool.toLowerCase()))
      ) {
        return false;
      }
      return true;
    };
    return this.entries
      .filter((entry) => Number(entry.id) < before && matches(entry))
      .slice(-limit)
      .reverse()
      .map(({ raw: _raw, ...entry }) => entry);
  }

  /** Test convenience: rows matching an action, newest first. */
  byAction(action: AuditLogEntry["action"]): AuditLogEntry[] {
    return this.entries.filter((entry) => entry.action === action).map(({ raw: _raw, ...entry }) => entry);
  }

  async toolStats(): Promise<UpstreamToolStats[]> {
    type MutableStats = {
      upstreamId: string;
      calls: number;
      errors: number;
      avgDurationMs: number;
      maxDurationMs: number;
      lastCalledAt: string | null;
    };
    const byUpstream = new Map<string, MutableStats>();
    for (const entry of this.entries) {
      if (entry.action !== "tool_call" || entry.upstreamId === null) continue;
      const current = byUpstream.get(entry.upstreamId) ?? {
        upstreamId: entry.upstreamId,
        calls: 0,
        errors: 0,
        avgDurationMs: 0,
        maxDurationMs: 0,
        lastCalledAt: null as string | null,
      };
      current.calls += 1;
      if (entry.outcome === "error") current.errors += 1;
      current.maxDurationMs = Math.max(current.maxDurationMs, entry.durationMs);
      // Running mean, rounded like the SQL round(avg(...)).
      current.avgDurationMs = Math.round(
        (current.avgDurationMs * (current.calls - 1) + entry.durationMs) / current.calls,
      );
      const at = entry.occurredAt;
      if (current.lastCalledAt === null || at > current.lastCalledAt) current.lastCalledAt = at;
      byUpstream.set(entry.upstreamId, current);
    }
    return [...byUpstream.values()] as UpstreamToolStats[];
  }
}

/** In-memory web_sessions (D23): same contract as the PostgreSQL one. */
export class FakeSessionRepository implements SessionRepository {
  private readonly rows = new Map<string, StoredSession>();
  down = false;

  private guard(): void {
    if (this.down) {
      throw new Error("fake session store is down (ECONNREFUSED 127.0.0.1:5432)");
    }
  }

  async create(session: StoredSession): Promise<void> {
    this.guard();
    this.rows.set(session.tokenHash, session);
  }

  async find(tokenHash: string): Promise<StoredSession | null> {
    this.guard();
    return this.rows.get(tokenHash) ?? null;
  }

  async delete(tokenHash: string): Promise<boolean> {
    this.guard();
    return this.rows.delete(tokenHash);
  }

  async deleteExpired(nowIso: string): Promise<number> {
    this.guard();
    let removed = 0;
    for (const [hash, row] of this.rows) {
      if (Date.parse(row.expiresAt) <= Date.parse(nowIso)) {
        this.rows.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test convenience. */
  get size(): number {
    return this.rows.size;
  }
}

/** In-memory upstream_overrides (D24): same contract as the PostgreSQL one. */
export class FakeUpstreamStateRepository implements UpstreamStateRepository {
  readonly overrides = new Map<string, { enabled: boolean; updatedBy: string | null }>();
  down = false;

  private guard(): void {
    if (this.down) {
      throw new Error("fake upstream state store is down (ECONNREFUSED 127.0.0.1:5432)");
    }
  }

  async getOverrides(): Promise<Record<string, boolean>> {
    this.guard();
    const out: Record<string, boolean> = {};
    for (const [id, entry] of this.overrides) {
      out[id] = entry.enabled;
    }
    return out;
  }

  async setOverride(upstreamId: string, enabled: boolean, updatedBy: string | null): Promise<void> {
    this.guard();
    this.overrides.set(upstreamId, { enabled, updatedBy });
  }
}

export interface FakeRegistryEntry {
  id: string;
  enabled: boolean;
  reachable?: boolean;
  lastErrorMessage?: string | null;
  tools?: Array<Omit<AggregatedTool, "enabled">>;
}

/**
 * Registry stand-in for REST-layer tests: mirrors the real contract
 * (enable gating in listAggregatedTools, health(), setEnabled, and the
 * Milestone 11 dynamic add/remove surface) without any MCP client or
 * network. MCP-path behaviour of the *real* registry is covered by the
 * mcp- and authz- suites through the gateway harness.
 */
export class FakeUpstreamRegistry implements UpstreamRegistry {
  readonly entries: FakeRegistryEntry[];
  readonly toggles: Array<{ id: string; enabled: boolean }> = [];
  /** Configs passed to addOrUpdateServer (D34), in call order. */
  readonly registered: Array<{ config: UpstreamConfig; credential: UpstreamCredential | null }> = [];

  constructor(entries: FakeRegistryEntry[]) {
    this.entries = entries;
  }

  async listAggregatedTools(): Promise<AggregatedTool[]> {
    return this.entries
      .filter((entry) => entry.enabled)
      .flatMap((entry) => entry.tools ?? [])
      .map((tool) => ({ ...tool, enabled: true }));
  }

  async callTool(): Promise<never> {
    throw new Error("FakeUpstreamRegistry.callTool is not used by these tests");
  }

  health(): UpstreamHealth[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      enabled: entry.enabled,
      reachable: entry.reachable ?? false,
      lastCheckedAt: new Date().toISOString(),
      lastErrorMessage: entry.lastErrorMessage ?? null,
    }));
  }

  upstreamIds(): readonly string[] {
    return this.entries.map((entry) => entry.id);
  }

  async addOrUpdateServer(config: UpstreamConfig, credential: UpstreamCredential | null): Promise<void> {
    this.registered.push({ config, credential });
    const entry = this.entries.find((candidate) => candidate.id === config.id);
    if (entry !== undefined) {
      entry.enabled = config.enabled;
      return;
    }
    this.entries.push({ id: config.id, enabled: config.enabled, reachable: false });
  }

  async removeServer(upstreamId: string): Promise<boolean> {
    const index = this.entries.findIndex((candidate) => candidate.id === upstreamId);
    if (index === -1) {
      return false;
    }
    this.entries.splice(index, 1);
    return true;
  }

  setEnabled(upstreamId: string, enabled: boolean): boolean {
    const entry = this.entries.find((candidate) => candidate.id === upstreamId);
    if (entry === undefined) {
      return false;
    }
    entry.enabled = enabled;
    this.toggles.push({ id: entry.id, enabled });
    return true;
  }

  async refresh(): Promise<void> {}

  async close(): Promise<void> {}
}

/**
 * In-memory dynamic_upstreams table (D34): same contract as the PostgreSQL
 * repository, including unique-URL enforcement. `down = true` simulates a
 * database outage for fail-closed tests.
 */
export class FakeDynamicUpstreamRepository implements DynamicUpstreamRepository {
  private readonly rows = new Map<string, DynamicUpstreamRecord>();
  down = false;

  private guard(): void {
    if (this.down) {
      throw new Error("fake dynamic upstream repository is down");
    }
  }

  private copy(row: DynamicUpstreamRecord): DynamicUpstreamRecord {
    return { ...row, credentialCipher: row.credentialCipher === null ? null : Buffer.from(row.credentialCipher) };
  }

  async list(): Promise<DynamicUpstreamRecord[]> {
    this.guard();
    return [...this.rows.values()].map((row) => this.copy(row));
  }

  async findById(id: string): Promise<DynamicUpstreamRecord | null> {
    this.guard();
    const row = this.rows.get(id);
    return row === undefined ? null : this.copy(row);
  }

  async findByUrl(url: string): Promise<DynamicUpstreamRecord | null> {
    this.guard();
    for (const row of this.rows.values()) {
      if (row.url === url) {
        return this.copy(row);
      }
    }
    return null;
  }

  async create(id: string, input: DynamicUpstreamWrite, createdBy: string | null): Promise<DynamicUpstreamRecord> {
    this.guard();
    for (const row of this.rows.values()) {
      if (row.url === input.url) {
        throw new DuplicateUpstreamUrlError();
      }
    }
    const stamp = new Date().toISOString();
    const row: DynamicUpstreamRecord = {
      id,
      name: input.name,
      url: input.url,
      enabled: input.enabled,
      credentialMode: input.credentialMode,
      credentialHeaderName: input.credentialHeaderName,
      credentialCipher: input.credentialCipher === null ? null : Buffer.from(input.credentialCipher),
      createdAt: stamp,
      updatedAt: stamp,
    };
    void createdBy;
    this.rows.set(id, row);
    return this.copy(row);
  }

  async update(id: string, input: DynamicUpstreamWrite, updatedBy: string | null): Promise<DynamicUpstreamRecord | null> {
    this.guard();
    const existing = this.rows.get(id);
    if (existing === undefined) {
      return null;
    }
    for (const row of this.rows.values()) {
      if (row.id !== id && row.url === input.url) {
        throw new DuplicateUpstreamUrlError();
      }
    }
    const updated: DynamicUpstreamRecord = {
      ...existing,
      name: input.name,
      url: input.url,
      enabled: input.enabled,
      credentialMode: input.credentialMode,
      credentialHeaderName: input.credentialHeaderName,
      credentialCipher: input.credentialCipher === null ? null : Buffer.from(input.credentialCipher),
      updatedAt: new Date().toISOString(),
    };
    void updatedBy;
    this.rows.set(id, updated);
    return this.copy(updated);
  }

  async delete(id: string): Promise<boolean> {
    this.guard();
    return this.rows.delete(id);
  }

  async setEnabled(id: string, enabled: boolean, updatedBy: string | null): Promise<boolean> {
    this.guard();
    const row = this.rows.get(id);
    if (row === undefined) {
      return false;
    }
    this.rows.set(id, { ...row, enabled, updatedAt: new Date().toISOString() });
    void updatedBy;
    return true;
  }
}
