import { createApp } from "./app.ts";
import { loadConfig, safeConfigSummary } from "./config.ts";
import { ConfigurationError } from "./errors.ts";
import { createLogger } from "./logger.ts";

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

  if (config.storeUrl.startsWith("http://")) {
    logger.warn("insecure_store_url", {
      message:
        "WOOCOMMERCE_STORE_URL uses http://. WooCommerce only accepts Basic authentication when the store is served over HTTPS, so API calls will likely fail with HTTP 401.",
    });
  }

  logger.info("config_loaded", { ...safeConfigSummary(config) });

  const { app, close } = createApp({ config, logger });
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
    void close().finally(() => {
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
