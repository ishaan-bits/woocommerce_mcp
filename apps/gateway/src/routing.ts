import { UPSTREAM_IDS } from "@mcp/shared";

export interface ParsedToolName {
  upstreamId: string;
  localName: string;
}

export function qualifyToolName(upstreamId: string, localName: string): string {
  return `${upstreamId}_${localName}`;
}

/**
 * Fixed deploy-time ids ∪ the registry's live ids (M11/D34).
 *
 * Authorization and grant validation must always recognise EVERY fixed id —
 * even one that is not configured via env — so an unconfigured fixed
 * upstream's tools still fail closed through the grant path (and cannot slip
 * past authorization into the validation/unknown-tool path). Admin-registered
 * dynamic ids only exist live, so the union is exactly "everything the
 * gateway could ever route to, plus the fixed names it must still refuse".
 */
export function unionUpstreamIds(liveIds: readonly string[]): string[] {
  return [...new Set<string>([...UPSTREAM_IDS, ...liveIds])];
}

/**
 * Split `<upstream>_<tool>` back into its parts (architecture §5).
 *
 * `knownUpstreamIds` defaults to the deploy-time UPSTREAM_IDS so every
 * existing caller keeps its behaviour; the registry passes its live ids
 * (fixed + admin-registered) at runtime. Matching tries the LONGEST id first,
 * so a dynamic id that contains another id as a prefix (e.g. `inventory-lab`
 * vs `inventory`) can never steal a tool name from the longer id.
 */
export function parseToolName(
  qualifiedName: string,
  knownUpstreamIds: readonly string[] = UPSTREAM_IDS,
): ParsedToolName | null {
  if (qualifiedName.length === 0) {
    return null;
  }
  const idsByLength = [...new Set(knownUpstreamIds)].sort((a, b) => b.length - a.length);
  for (const upstreamId of idsByLength) {
    const prefix = `${upstreamId}_`;
    if (qualifiedName.startsWith(prefix)) {
      const localName = qualifiedName.slice(prefix.length);
      if (localName.length > 0) {
        return { upstreamId, localName };
      }
    }
  }
  return null;
}
