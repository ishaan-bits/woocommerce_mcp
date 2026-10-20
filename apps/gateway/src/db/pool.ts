import pg from "pg";

export type Pool = pg.Pool;

/**
 * Pool for gateway data access. `max` kept small: one gateway process, two
 * surfaces (MCP + REST), a couple of demo users. `statement_timeout` bounds a
 * hung database so requests fail closed instead of hanging (C7 spirit).
 */
export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    statement_timeout: 5_000,
    application_name: "urumi-mcp-gateway",
  });
}
