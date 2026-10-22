import type { Pool } from "./pool.ts";
import {
  DuplicateUpstreamUrlError,
  type DynamicUpstreamRecord,
  type DynamicUpstreamRepository,
  type DynamicUpstreamWrite,
} from "./dynamic-upstream-repository.ts";

interface DynamicUpstreamRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  credential_mode: "bearer" | "header" | null;
  credential_header_name: string | null;
  credential_cipher: Buffer | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SELECT_COLUMNS = `id, name, url, enabled, credential_mode, credential_header_name,
       credential_cipher, created_at, updated_at`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: DynamicUpstreamRow): DynamicUpstreamRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    credentialMode: row.credential_mode,
    credentialHeaderName: row.credential_header_name,
    credentialCipher: row.credential_cipher,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Postgres unique_violation — the only error this layer interprets. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export function createPostgresDynamicUpstreamRepository(pool: Pool): DynamicUpstreamRepository {
  return {
    async list(): Promise<DynamicUpstreamRecord[]> {
      const result = await pool.query<DynamicUpstreamRow>(
        `SELECT ${SELECT_COLUMNS} FROM dynamic_upstreams ORDER BY created_at, id`,
      );
      return result.rows.map(toRecord);
    },

    async findById(id): Promise<DynamicUpstreamRecord | null> {
      const result = await pool.query<DynamicUpstreamRow>(
        `SELECT ${SELECT_COLUMNS} FROM dynamic_upstreams WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async findByUrl(url): Promise<DynamicUpstreamRecord | null> {
      const result = await pool.query<DynamicUpstreamRow>(
        `SELECT ${SELECT_COLUMNS} FROM dynamic_upstreams WHERE url = $1`,
        [url],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async create(id, input, createdBy): Promise<DynamicUpstreamRecord> {
      try {
        const result = await pool.query<DynamicUpstreamRow>(
          `INSERT INTO dynamic_upstreams
             (id, name, url, enabled, credential_mode, credential_header_name, credential_cipher, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           RETURNING ${SELECT_COLUMNS}`,
          [
            id,
            input.name,
            input.url,
            input.enabled,
            input.credentialMode,
            input.credentialHeaderName,
            input.credentialCipher,
            createdBy,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error("insert returned no row");
        }
        return toRecord(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateUpstreamUrlError();
        }
        throw error;
      }
    },

    async update(id, input, updatedBy): Promise<DynamicUpstreamRecord | null> {
      try {
        const result = await pool.query<DynamicUpstreamRow>(
          `UPDATE dynamic_upstreams
             SET name = $2, url = $3, enabled = $4,
                 credential_mode = $5, credential_header_name = $6, credential_cipher = $7,
                 updated_at = now(), updated_by = $8
           WHERE id = $1
           RETURNING ${SELECT_COLUMNS}`,
          [
            id,
            input.name,
            input.url,
            input.enabled,
            input.credentialMode,
            input.credentialHeaderName,
            input.credentialCipher,
            updatedBy,
          ],
        );
        const row = result.rows[0];
        return row === undefined ? null : toRecord(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateUpstreamUrlError();
        }
        throw error;
      }
    },

    async delete(id): Promise<boolean> {
      const result = await pool.query(`DELETE FROM dynamic_upstreams WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    },

    async setEnabled(id, enabled, updatedBy): Promise<boolean> {
      const result = await pool.query(
        `UPDATE dynamic_upstreams
           SET enabled = $2, updated_at = now(), updated_by = $3
         WHERE id = $1`,
        [id, enabled, updatedBy],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}
