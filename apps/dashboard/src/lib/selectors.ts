/**
 * Pure selectors over upstream + tool data (test/selectors.test.ts). Pages
 * use these for status labels, per-upstream tool grouping and search/filter
 * so the logic stays testable outside the DOM.
 */

import { formatLocalTime } from "./audit.ts";
import type { ToolView, UpstreamStatusView } from "../api/client.ts";

export type UpstreamHealth =
  | "missing"
  | "disabled"
  | "degraded"
  | "healthy";

/** Distinct health label: not configured, disabled, unreachable, or healthy. */
export function upstreamHealth(entry: UpstreamStatusView): UpstreamHealth {
  if (!entry.configured) return "missing";
  if (!entry.enabled) return "disabled";
  return entry.reachable ? "healthy" : "degraded";
}

export function upstreamHealthTone(health: UpstreamHealth): "neutral" | "warn" | "error" | "success" {
  switch (health) {
    case "healthy":
      return "success";
    case "disabled":
      return "neutral";
    case "degraded":
      return "error";
    default:
      return "warn";
  }
}

export function upstreamHealthText(entry: UpstreamStatusView): string {
  switch (upstreamHealth(entry)) {
    case "missing":
      return "Missing (not configured)";
    case "disabled":
      return "Disabled";
    case "degraded":
      return "Degraded (unreachable)";
    default:
      return "Healthy";
  }
}

/** Strip characters that look like an internal URL before showing an error. */
export function sanitizeError(message: string | null, max = 160): string | null {
  if (message === null || message === "") return null;
  const withoutUrls = message
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutUrls.length === 0) return null;
  return withoutUrls.length > max ? `${withoutUrls.slice(0, max - 1)}…` : withoutUrls;
}

export interface UpstreamWithTools {
  id: string;
  status: UpstreamStatusView;
  tools: ToolView[];
}

/** Group tools by upstream id, preserving the status order from the API. */
export function groupToolsByUpstream(
  statuses: readonly UpstreamStatusView[],
  tools: readonly ToolView[],
): UpstreamWithTools[] {
  const byId = new Map<string, ToolView[]>();
  for (const tool of tools) {
    const list = byId.get(tool.upstream_id);
    if (list === undefined) {
      byId.set(tool.upstream_id, [tool]);
    } else {
      list.push(tool);
    }
  }
  return statuses.map((status) => ({
    id: status.id,
    status,
    tools: byId.get(status.id) ?? [],
  }));
}

/** Case-insensitive search across qualified name, local name and description. */
export function matchesToolSearch(tool: ToolView, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (query === "") return true;
  return (
    tool.qualified_name.toLowerCase().includes(query) ||
    tool.name.toLowerCase().includes(query) ||
    tool.description.toLowerCase().includes(query)
  );
}

export function filterTools(
  tools: readonly ToolView[],
  options: { search?: string; upstreamId?: string },
): ToolView[] {
  const search = options.search ?? "";
  const upstreamId = options.upstreamId ?? "";
  return tools.filter(
    (tool) =>
      (upstreamId === "" || tool.upstream_id === upstreamId) && matchesToolSearch(tool, search),
  );
}

/** Count summary text, e.g. "12 of 30 tools". */
export function toolCountSummary(shown: number, total: number): string {
  return shown === total ? `${total} tools` : `${shown} of ${total} tools`;
}

/**
 * One-line observability summary for an upstream's tool-call metrics
 * (stand-out 8). Returns null when the gateway sent no stats so the UI can
 * hide the line instead of inventing numbers.
 */
export function upstreamStatsSummary(
  stats: { calls: number; errors: number; avgDurationMs: number; lastCalledAt: string | null } | null | undefined,
): string | null {
  if (stats === null || stats === undefined) return null;
  if (stats.calls === 0) return "No tool calls yet";
  const parts = [
    `${stats.calls} call${stats.calls === 1 ? "" : "s"}`,
    `${stats.errors} error${stats.errors === 1 ? "" : "s"}`,
    `avg ${stats.avgDurationMs} ms`,
  ];
  if (stats.lastCalledAt !== null) {
    parts.push(`last ${formatLocalTime(stats.lastCalledAt)}`);
  }
  return parts.join(" · ");
}
