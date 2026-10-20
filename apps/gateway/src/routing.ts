import { UPSTREAM_IDS, type UpstreamId } from "@mcp/shared";

export interface ParsedToolName {
  upstreamId: UpstreamId;
  localName: string;
}

export function qualifyToolName(upstreamId: UpstreamId, localName: string): string {
  return `${upstreamId}_${localName}`;
}

export function parseToolName(qualifiedName: string): ParsedToolName | null {
  for (const upstreamId of UPSTREAM_IDS) {
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
