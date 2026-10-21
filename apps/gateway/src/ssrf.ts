import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GatewayError } from "./errors.ts";

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemDnsLookup: DnsLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
};

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value;
}

function inIpv4Range(value: number, base: string, prefixBits: number): boolean {
  const baseValue = parseIpv4(base);
  if (baseValue === null || prefixBits < 0 || prefixBits > 32) {
    return false;
  }
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

/**
 * Non-routable / internal IPv4 ranges, including the cloud metadata address
 * 169.254.169.254 (link-local) and CGNAT (carrier-grade NAT).
 */
const PRIVATE_IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPrivateIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) {
    return false;
  }
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => inIpv4Range(value, base, bits));
}

function expandIpv6(address: string): bigint | null {
  let text = address;
  // Strip a zone index (fe80::1%eth0).
  const percent = text.indexOf("%");
  if (percent !== -1) {
    text = text.slice(0, percent);
  }
  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two hextets.
  const lastColon = text.lastIndexOf(":");
  if (lastColon !== -1 && text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  if (tail === undefined && headGroups.length !== 8) {
    return null;
  }
  if (headGroups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g)) || tailGroups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) {
    return null;
  }
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined || missing < 0) {
    return missing === 0 ? groupsToBigInt([...headGroups]) : null;
  }
  return groupsToBigInt([...headGroups, ...Array(missing).fill("0"), ...tailGroups]);
}

function groupsToBigInt(groups: string[]): bigint {
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function isPrivateIpv6(address: string): boolean {
  const value = expandIpv6(address);
  if (value === null) {
    return false;
  }
  // :: (unspecified) and ::1 (loopback).
  if (value <= 1n) {
    return true;
  }
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): classify the
  // embedded IPv4 address.
  if (value >> 32n === 0xffffn || value < (1n << 32n)) {
    const v4 = value & 0xffffffffn;
    return isPrivateIpv4(numberToIpv4(v4));
  }
  // fc00::/7 unique-local.
  if ((value >> 121n) === 0b1111110n) {
    return true;
  }
  // fe80::/10 link-local.
  if ((value >> 118n) === 0b1111111010n) {
    return true;
  }
  // ff00::/8 multicast.
  if ((value >> 120n) === 0xffn) {
    return true;
  }
  return false;
}

function numberToIpv4(value: bigint): string {
  const n = Number(value);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/** True when the address is loopback, link-local, private, CGNAT or otherwise non-routable. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return false;
}

/** URL.hostname keeps brackets around IPv6 literals; normalize to the bare address/name. */
export function hostnameOf(url: URL): string {
  const host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

export interface SsrfPolicy {
  /**
   * Hostnames (exact, case-insensitive) or literal addresses that may resolve
   * to private ranges. The special entry "*" allows every target (development
   * escape hatch only).
   */
  allowedPrivateHosts: readonly string[];
}

export interface SsrfGuardOptions extends SsrfPolicy {
  lookup?: DnsLookup;
}

/**
 * C4: refuse to contact an upstream whose address is non-routable unless the
 * host is explicitly allow-listed. Literal addresses are rejected up front;
 * hostnames are resolved and every resolved address must be routable (an
 * attacker-controlled DNS answer pointing at 169.254.169.254 is blocked).
 */
export async function assertUpstreamTargetAllowed(url: URL, options: SsrfGuardOptions): Promise<void> {
  if (options.allowedPrivateHosts.includes("*")) {
    return;
  }
  const host = hostnameOf(url);
  const allowed = options.allowedPrivateHosts.some((entry) => entry.toLowerCase() === host.toLowerCase());
  if (allowed) {
    return;
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new GatewayError(
        "blocked_private_address",
        `upstream address '${host}' is a non-routable address and is not allow-listed (set UPSTREAM_ALLOWED_PRIVATE_HOSTS if this is intentional)`,
      );
    }
    return;
  }
  const lookup = options.lookup ?? systemDnsLookup;
  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookup(host);
  } catch {
    throw new GatewayError("connection", `upstream host '${host}' could not be resolved`, { cause: undefined });
  }
  if (results.length === 0) {
    throw new GatewayError("connection", `upstream host '${host}' could not be resolved`);
  }
  const offending = results.filter((entry) => isPrivateAddress(entry.address));
  if (offending.length > 0) {
    throw new GatewayError(
      "blocked_private_address",
      `upstream host '${host}' resolves to a non-routable address which is not allow-listed (set UPSTREAM_ALLOWED_PRIVATE_HOSTS if this is intentional)`,
    );
  }
}

/**
 * C4 response-size cap: the SDK transport accepts a custom fetch. This one
 * rejects oversized bodies up front (Content-Length) and aborts mid-stream
 * when a chunked response lies about its size.
 */
export function createCappedFetch(maxBytes: number, upstreamId: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (maxBytes <= 0) {
      return response;
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new GatewayError(
          "response_too_large",
          `upstream '${upstreamId}' response exceeds the ${maxBytes} byte limit`,
          { upstreamId },
        );
      }
    }
    if (response.body === null) {
      return response;
    }
    let seen = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new GatewayError(
              "response_too_large",
              `upstream '${upstreamId}' response exceeds the ${maxBytes} byte limit`,
              { upstreamId },
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(counter), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
