import type { Pool } from "./pool.ts";
import type { UpstreamStateRepository } from "./upstream-state-repository.ts";

export function createPostgresUpstreamStateRepository(pool: Pool): UpstreamStateRepository {
  return {
    async getOverrides(): Promise<Record<string, boolean>> {
      const result = await pool.query<{ upstream_id: string; enabled: boolean }>(
        `SELECT upstream_id, enabled FROM upstream_overrides`,
      );
      const overrides: Record<string, boolean> = {};
      for (const row of result.rows) {
        overrides[row.upstream_id] = row.enabled;
      }
      return overrides;
    },

    async setOverride(upstreamId: string, enabled: boolean, updatedBy: string | null): Promise<void> {
      await pool.query(
        `INSERT INTO upstream_overrides (upstream_id, enabled, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (upstream_id)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [upstreamId, enabled, updatedBy],
      );
    },
  };
}
