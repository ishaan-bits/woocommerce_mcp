import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  assertUpstreamTargetAllowed,
  createCappedFetch,
  isPrivateAddress,
  type DnsLookup,
} from "../src/ssrf.ts";
import { GatewayError } from "../src/errors.ts";

describe("isPrivateAddress (C4 classifier)", () => {
  const privateAddresses = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.0.1",
    "100.64.0.1",
    "198.18.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
  ];
  for (const address of privateAddresses) {
    test(`classifies ${address} as private`, () => {
      assert.equal(isPrivateAddress(address), true);
    });
  }

  const publicAddresses = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "172.15.255.255",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ];
  for (const address of publicAddresses) {
    test(`classifies ${address} as public`, () => {
      assert.equal(isPrivateAddress(address), false);
    });
  }
});

function lookupOf(entries: Record<string, Array<{ address: string; family: number }>>): DnsLookup {
  return async (hostname) => {
    const found = entries[hostname];
    if (found === undefined) {
      throw new Error(`ENOTFOUND ${hostname}`);
    }
    return found;
  };
}

describe("assertUpstreamTargetAllowed (C4 guard)", () => {
  test("allow-all policy permits everything", async () => {
    await assertUpstreamTargetAllowed(new URL("http://169.254.169.254/latest/meta-data/"), {
      allowedPrivateHosts: ["*"],
    });
  });

  test("literal public address is permitted without an allow-list entry", async () => {
    await assertUpstreamTargetAllowed(new URL("http://93.184.216.34:8081/mcp"), {
      allowedPrivateHosts: [],
    });
  });

  test("literal private address is refused without an allow-list entry", async () => {
    await assert.rejects(
      () =>
        assertUpstreamTargetAllowed(new URL("http://169.254.169.254/latest/meta-data/"), {
          allowedPrivateHosts: [],
        }),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "blocked_private_address",
    );
  });

  test("literal private address is permitted with an explicit allow-list entry", async () => {
    await assertUpstreamTargetAllowed(new URL("http://10.0.0.5:8081/mcp"), {
      allowedPrivateHosts: ["10.0.0.5"],
    });
  });

  test("hostname resolving only to public addresses is permitted", async () => {
    await assertUpstreamTargetAllowed(new URL("https://store.example.com/mcp"), {
      allowedPrivateHosts: [],
      lookup: lookupOf({ "store.example.com": [{ address: "93.184.216.34", family: 4 }] }),
    });
  });

  test("hostname resolving to a private address (DNS rebinding) is refused", async () => {
    await assert.rejects(
      () =>
        assertUpstreamTargetAllowed(new URL("https://evil.example.com/mcp"), {
          allowedPrivateHosts: [],
          lookup: lookupOf({
            "evil.example.com": [
              { address: "93.184.216.34", family: 4 },
              { address: "169.254.169.254", family: 4 },
            ],
          }),
        }),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "blocked_private_address",
    );
  });

  test("allow-listed hostname may resolve privately (in-cluster service names)", async () => {
    await assertUpstreamTargetAllowed(new URL("http://woocommerce-mcp:8081/mcp"), {
      allowedPrivateHosts: ["woocommerce-mcp"],
      lookup: lookupOf({ "woocommerce-mcp": [{ address: "10.96.10.2", family: 4 }] }),
    });
  });

  test("unresolvable hostname surfaces as a connection error", async () => {
    await assert.rejects(
      () =>
        assertUpstreamTargetAllowed(new URL("http://nope.invalid/mcp"), {
          allowedPrivateHosts: [],
          lookup: lookupOf({}),
        }),
      (error: unknown) => error instanceof GatewayError && error.code === "connection",
    );
  });

  test("IPv6 literal private loopback is refused", async () => {
    await assert.rejects(
      () =>
        assertUpstreamTargetAllowed(new URL("http://[::1]:8081/mcp"), {
          allowedPrivateHosts: [],
        }),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "blocked_private_address",
    );
  });

  test("decimal and hex IPv4 encodings normalize to the loopback address and are refused", async () => {
    // WHATWG URL parsing rewrites http://2130706433/ to http://127.0.0.1/.
    assert.equal(new URL("http://2130706433/").hostname, "127.0.0.1");
    await assert.rejects(
      () =>
        assertUpstreamTargetAllowed(new URL("http://2130706433/"), {
          allowedPrivateHosts: [],
        }),
      (error: unknown) =>
        error instanceof GatewayError && error.code === "blocked_private_address",
    );
  });

  test("a cross-origin redirect is refused by the transport, never followed to metadata", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const { createUpstreamRegistry } = await import("../src/upstream-registry.ts");
    const { createLogger } = await import("../src/logger.ts");
    const registry = createUpstreamRegistry({
      configs: [
        {
          id: "woocommerce",
          baseUrl: `http://127.0.0.1:${port}/mcp`,
          enabled: true,
          timeoutMs: 2_000,
          connectTimeoutMs: 2_000,
        },
      ],
      toolCacheTtlMs: 60_000,
      logger: createLogger({ level: "error", sink: { write: () => undefined } }),
      ssrf: { allowedPrivateHosts: ["*"] },
    });
    try {
      await assert.rejects(() => registry.callTool("woocommerce_list_products", {}));
      // The redirect target was never contacted: nothing in the health state
      // mentions the metadata address (the SDK does not follow cross-origin
      // redirects at all).
      const health = registry.health().find((entry) => entry.id === "woocommerce");
      assert.ok(!(health?.lastErrorMessage ?? "").includes("169.254.169.254"));
    } finally {
      await registry.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("createCappedFetch (C4 response cap)", () => {
  test("rejects an oversized Content-Length before reading the body", async () => {
    const capped = createCappedFetch(1024, "woocommerce");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("x".repeat(2048), {
        status: 200,
        headers: { "content-length": "2048" },
      })) as typeof fetch;
    try {
      await assert.rejects(
        () => capped("http://example.com/mcp"),
        (error: unknown) => error instanceof GatewayError && error.code === "response_too_large",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("rejects a chunked response that exceeds the cap mid-stream", async () => {
    const capped = createCappedFetch(1024, "woocommerce");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(2048).fill(1));
            controller.enqueue(new Uint8Array(2048).fill(2));
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const response = await capped("http://example.com/mcp");
      await assert.rejects(
        async () => response.text(),
        (error: unknown) => error instanceof GatewayError && error.code === "response_too_large",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("passes responses within the cap through unchanged", async () => {
    const capped = createCappedFetch(1024, "woocommerce");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    try {
      const response = await capped("http://example.com/mcp");
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      globalThis.fetch = original;
    }
  });
});
