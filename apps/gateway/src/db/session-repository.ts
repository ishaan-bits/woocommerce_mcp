/**
 * Dashboard session storage (D23): PostgreSQL in production (D7), an
 * in-memory fake in unit tests. Only the sha256 digest of the cookie token
 * is ever stored — the plaintext token exists exactly once, in Set-Cookie.
 */
export interface StoredSession {
  readonly tokenHash: string;
  readonly userId: string;
  readonly keyId: string;
  /** ISO timestamp; the row is invalid from this moment on. */
  readonly expiresAt: string;
}

export interface SessionRepository {
  create(session: StoredSession): Promise<void>;
  find(tokenHash: string): Promise<StoredSession | null>;
  /** Logout: true when a row was removed. */
  delete(tokenHash: string): Promise<boolean>;
  /** Opportunistic cleanup (called after successful logins). */
  deleteExpired(nowIso: string): Promise<number>;
}
