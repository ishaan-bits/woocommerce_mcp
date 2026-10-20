import { createApp } from "./app.ts";
import { loadConfig, safeConfigSummary } from "./config.ts";
import { ConfigurationError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { createUpstreamRegistry } from "./upstream-registry.ts";
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

  const registry = createUpstreamRegistry({
    configs: config.upstreams,
    toolCacheTtlMs: config.toolCacheTtlMs,
    logger,
    clientInfo: { name: "urumi-mcp-gateway", version: VERSION },
  });

  void registry.refresh().catch((error: unknown) => {
    logger.warn("startup_refresh_failed", { error: String(error) });
  });

  const { app, close } = createApp({ config, logger, registry });
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
      .finally(() => {
        logger.info("shutdown_complete", {});
        process.exit(0);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal error: ${String(error)}\n`);
  process.exit(1);
});
