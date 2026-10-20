import express, { type Express } from "express";
import type { Server } from "node:http";

export interface MiniApp {
  origin: string;
  close(): Promise<void>;
}

/**
 * Tiny HTTP harness for middleware/API unit tests: real express + real
 * listen(), so tests exercise header parsing and JSON bodies exactly as the
 * gateway does, without upstreams or MCP sessions.
 */
export async function startMiniApp(build: (app: Express) => void): Promise<MiniApp> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  build(app);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
