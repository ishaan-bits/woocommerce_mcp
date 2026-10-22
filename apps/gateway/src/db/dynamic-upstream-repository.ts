/**
 * Admin-registered dynamic MCP upstreams (Milestone 11, D34).
 *
 * Rows pair identity + endpoint + enablement with an OPTIONAL credential
 * held here as AES-256-GCM ciphertext only (upstream-credentials.ts owns the
 * encrypt/decrypt boundary; this layer never sees plaintext). Fixed
 * deploy-time servers stay in environment config + upstream_overrides — a
 * dynamic row can never rewrite a fixed server, and a fixed server cannot be
 * edited or removed through this repository.
 */
export interface DynamicUpstreamRecord {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** null = no credential configured for this server. */
  credentialMode: "bearer" | "header" | null;
  credentialHeaderName: string | null;
  /** Ciphertext (iv || tag || payload). Never serialized to a response. */
  credentialCipher: Buffer | null;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicUpstreamWrite {
  name: string;
  url: string;
  enabled: boolean;
  credentialMode: "bearer" | "header" | null;
  credentialHeaderName: string | null;
  credentialCipher: Buffer | null;
}

/** Raised when a different server already owns the normalized URL. */
export class DuplicateUpstreamUrlError extends Error {
  constructor() {
    super("an upstream with this URL already exists");
    this.name = "DuplicateUpstreamUrlError";
  }
}

export interface DynamicUpstreamRepository {
  list(): Promise<DynamicUpstreamRecord[]>;
  findById(id: string): Promise<DynamicUpstreamRecord | null>;
  findByUrl(url: string): Promise<DynamicUpstreamRecord | null>;
  /** Insert a new row; throws DuplicateUpstreamUrlError on URL conflict. */
  create(id: string, input: DynamicUpstreamWrite, createdBy: string | null): Promise<DynamicUpstreamRecord>;
  /** Update an existing row; returns null when the id is unknown. */
  update(id: string, input: DynamicUpstreamWrite, updatedBy: string | null): Promise<DynamicUpstreamRecord | null>;
  /** Remove a row; returns false when the id is unknown. */
  delete(id: string): Promise<boolean>;
  /** Enable/disable without touching anything else; false when unknown. */
  setEnabled(id: string, enabled: boolean, updatedBy: string | null): Promise<boolean>;
}
