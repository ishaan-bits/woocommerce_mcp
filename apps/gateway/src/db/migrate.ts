import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Migration runner (D7).
 *
 * Uses MIGRATE_DATABASE_URL (or DATABASE_URL) — the *admin* connection, because
 * creating tables and roles needs privileges the runtime role must not have.
 * When MCP_APP_DB_PASSWORD is set, it also creates/refreshes `mcp_gateway_app`,
 * the least-privilege runtime role: INSERT+SELECT on audit_log (append-only,
 * C6), SELECT on users, and column-limited UPDATE (revoked_at only) on
 * api_keys so keys can be revoked but never rewritten (C1).
 */

const APP_ROLE = "mcp_gateway_app";

export interface RunMigrationsOptions {
  /** Admin connection: creating tables and roles needs privileges the runtime role must not have. */
  databaseUrl: string;
  /** When set, creates/refreshes the least-privilege runtime role. */
  appPassword?: string;
  log?: (message: string) => void;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`unsafe SQL identifier from server: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const { databaseUrl, appPassword } = options;
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));

  const client = new pg.Client({ connectionString: databaseUrl, statement_timeout: 15_000 });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [file]);
      if ((rowCount ?? 0) > 0) {
        log(`skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      log(`applied ${file}`);
    }

    if (appPassword !== undefined && appPassword !== "") {
      const { rows: roleRows } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
      // DDL cannot take bind parameters (a real bug the integration test caught):
      // build the statement safely with format()/%I/%L, then execute it.
      const statement = await client.query<{ cmd: string }>(
        (roleRows.length ?? 0) === 0
          ? `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS cmd`
          : `SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS cmd`,
        [APP_ROLE, appPassword],
      );
      const command = statement.rows[0]?.cmd;
      if (command === undefined) {
        throw new Error("failed to build the runtime-role statement");
      }
      await client.query(command);
      const { rows: dbRows } = await client.query(`SELECT current_database() AS db`);
      const dbName = identifier(dbRows[0].db as string);
      await client.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${APP_ROLE}`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await client.query(`GRANT SELECT ON users, api_keys, audit_log TO ${APP_ROLE}`);
      await client.query(`GRANT INSERT, SELECT ON audit_log TO ${APP_ROLE}`);
      await client.query(`GRANT INSERT, SELECT, UPDATE (revoked_at) ON api_keys TO ${APP_ROLE}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
      log(`runtime role ${APP_ROLE} ready (append-only audit grants)`);
    } else {
      log(`MCP_APP_DB_PASSWORD not set - skipping ${APP_ROLE} role setup (dev-only single-user mode)`);
    }

    log("Migrations complete.");
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const adminUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (adminUrl === undefined || adminUrl.trim() === "") {
    process.stderr.write("Migrate failed: set DATABASE_URL (or MIGRATE_DATABASE_URL) first.\n");
    process.exitCode = 1;
    return;
  }
  await runMigrations({ databaseUrl: adminUrl, appPassword: process.env.MCP_APP_DB_PASSWORD });
}

// Run only when executed directly (`npm run migrate`), never on import by tests.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    // pg error messages can contain SQL fragments; keep them on the terminal
    // that asked for the migration, never in an HTTP response.
    process.stderr.write(`Migrate failed: ${String(error)}\n`);
    process.exit(1);
  });
}
