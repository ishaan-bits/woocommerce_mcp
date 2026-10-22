import type { AppConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { AuditRepository } from "./audit-repository.ts";
import type { AuthRepository } from "./auth-repository.ts";
import { createPool, type Pool } from "./pool.ts";
import { createPostgresAuditRepository } from "./postgres-audit-repository.ts";
import { createPostgresAuthRepository } from "./postgres-auth-repository.ts";
import { createPostgresDynamicUpstreamRepository } from "./postgres-dynamic-upstream-repository.ts";
import { createPostgresSessionRepository } from "./postgres-session-repository.ts";
import { createPostgresUpstreamStateRepository } from "./postgres-upstream-state-repository.ts";
import type { SessionRepository } from "./session-repository.ts";
import type { UpstreamStateRepository } from "./upstream-state-repository.ts";
import type { DynamicUpstreamRepository } from "./dynamic-upstream-repository.ts";

export interface DatabaseDeps {
  pool: Pool;
  authRepo: AuthRepository;
  auditRepo: AuditRepository;
  sessionRepo: SessionRepository;
  upstreamStateRepo: UpstreamStateRepository;
  dynamicUpstreamRepo: DynamicUpstreamRepository;
}

/** Production wiring: PostgreSQL only (D7) — unit tests inject fakes instead. */
export function createDatabaseDeps(config: AppConfig): DatabaseDeps {
  const pool = createPool(config.databaseUrl);
  return {
    pool,
    authRepo: createPostgresAuthRepository(pool),
    auditRepo: createPostgresAuditRepository(pool),
    sessionRepo: createPostgresSessionRepository(pool),
    upstreamStateRepo: createPostgresUpstreamStateRepository(pool),
    dynamicUpstreamRepo: createPostgresDynamicUpstreamRepository(pool),
  };
}
