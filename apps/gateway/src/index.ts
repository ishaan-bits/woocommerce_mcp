import { createApp } from "./app.ts";
import { loadConfig, safeConfigSummary } from "./config.ts";
import { ConfigurationError } from "./errors.ts";
import { createDatabaseDeps } from "./db/index.ts";
import { createLogger } from "./logger.ts";
import { applyUpstreamOverrides, createUpstreamRegistry } from "./upstream-registry.ts";
import { VERSION } from "./version.ts";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  logger.info("config_loaded", { ...safeConfigSummary(config) });

  // Fail fast with a safe message: no credentials, no SQL, no stack traces.
  const { pool, authRepo, auditRepo, sessionRepo, upstreamStateRepo } = createDatabaseDeps(config);
  try {
    await pool.query("SELECT 1");
    const { rows } = await pool.query(`SELECT to_regclass('public.users') AS t`);
    if (rows[0]?.t === null || rows[0]?.t === undefined) {
      process.stderr.write(
        "Gateway failed to start: database schema is missing. Run `npm run migrate -w @mcp/gateway` first.\n",
      );
      await pool.end();
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    process.stderr.write(`Gateway failed to start: cannot reach PostgreSQL (DATABASE_URL): ${safeDbError(error)}\n`);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
    return;
  }
  logger.info("database_ready", { host: safeHost(config.databaseUrl) });

  const registry = createUpstreamRegistry({
    configs: config.upstreams,
    toolCacheTtlMs: config.toolCacheTtlMs,
    logger,
    ssrf: { allowedPrivateHosts: config.upstreamAllowedPrivateHosts },
    maxConcurrentCallsPerUpstream: config.upstreamMaxConcurrentCalls,
    maxResponseBytes: config.upstreamMaxResponseBytes,
    clientInfo: { name: "urumi-mcp-gateway", version: VERSION },
  });

  // D24: persisted dashboard toggles survive restarts. Applied before the
  // first refresh so the initial tools/list already reflects them. A stored
  // id that is no longer configured via env is ignored (with a warning).
  try {
    const overrides = await upstreamStateRepo.getOverrides();
    const applied = applyUpstreamOverrides(registry, overrides, logger);
    logger.info("upstream_overrides_applied", { count: applied });
  } catch (error) {
    logger.error("upstream_overrides_failed", { error: String(error) });
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  void registry.refresh().catch((error: unknown) => {
    logger.warn("startup_refresh_failed", { error: String(error) });
  });

  const { app, close } = createApp({ config, logger, registry, authRepo, auditRepo, sessionRepo, upstreamStateRepo });
  const server = app.listen(config.port, config.host, () => {
    logger.info("listening", { host: config.host, port: config.port, mcp_path: "/mcp" });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutdown_started", { signal });
    server.close();
    void close()
      .finally(() => registry.close())
      .finally(async () => {
        await pool.end().catch((error: unknown) => {
          logger.warn("pool_close_failed", { error: String(error) });
        });
      })
      .finally(() => {
        logger.info("shutdown_complete", {});
        process.exit(0);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** pg errors can embed connection details; strip to a safe one-liner for the console. */
function safeDbError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0] ?? message;
  return firstLine.slice(0, 200);
}

/** Host only (no user/password) for the diagnostic log line. */
function safeHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).host;
  } catch {
    return "unknown";
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal error: ${String(error)}\n`);
  process.exit(1);
});
