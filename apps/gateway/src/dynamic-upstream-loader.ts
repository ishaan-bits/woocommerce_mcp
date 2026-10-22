import type { UpstreamConfig } from "@mcp/shared";
import type { DynamicUpstreamRepository } from "./db/dynamic-upstream-repository.ts";
import type { Logger } from "./logger.ts";
import type { CredentialVault, UpstreamCredential } from "./upstream-credentials.ts";

/**
 * Boot path for admin-registered upstreams (Milestone 11, D34): read the
 * rows, decrypt any credential with the configured vault, and hand the
 * registry its initial configs + in-memory credentials.
 *
 * FAIL CLOSED: if a stored credential exists without UPSTREAM_CREDENTIAL_KEY,
 * or a row cannot be decrypted (wrong/tampered key), loading returns an
 * error and the gateway refuses to start — an unreachable server is fine,
 * silently dropping credential protection is not. Error text never contains
 * ciphertext or plaintext credential material.
 */

export interface LoadedDynamicUpstreams {
  configs: UpstreamConfig[];
  credentials: Map<string, UpstreamCredential>;
}

export type LoadDynamicUpstreamsResult =
  | { ok: true; loaded: LoadedDynamicUpstreams }
  | { ok: false; error: string };

export interface LoadDynamicUpstreamsOptions {
  repo: DynamicUpstreamRepository;
  vault: CredentialVault | null;
  timeoutMs: number;
  connectTimeoutMs: number;
  logger?: Logger;
}

export async function loadDynamicUpstreamConfigs(
  options: LoadDynamicUpstreamsOptions,
): Promise<LoadDynamicUpstreamsResult> {
  const { repo, vault, timeoutMs, connectTimeoutMs, logger } = options;
  let rows;
  try {
    rows = await repo.list();
  } catch (error) {
    logger?.error("dynamic_upstreams_load_failed", { error: String(error) });
    return { ok: false, error: "could not read dynamic_upstreams from the database" };
  }

  const configs: UpstreamConfig[] = [];
  const credentials = new Map<string, UpstreamCredential>();
  for (const row of rows) {
    if (row.credentialCipher !== null) {
      if (vault === null) {
        return {
          ok: false,
          error:
            `upstream '${row.id}' has an encrypted credential but UPSTREAM_CREDENTIAL_KEY is not set; ` +
            "refusing to start (set the key or remove the credential)",
        };
      }
      let plaintext: string;
      try {
        plaintext = vault.decrypt(row.credentialCipher, row.id);
      } catch (error) {
        logger?.error("dynamic_upstream_credential_decrypt_failed", {
          upstream_id: row.id,
          error: error instanceof Error ? error.message : "decrypt failed",
        });
        return {
          ok: false,
          error: `stored credential for upstream '${row.id}' could not be decrypted; refusing to start`,
        };
      }
      if (row.credentialMode === null) {
        return { ok: false, error: `upstream '${row.id}' has a credential without a mode; refusing to start` };
      }
      credentials.set(row.id, {
        mode: row.credentialMode,
        value: plaintext,
        headerName: row.credentialHeaderName,
      });
    }
    configs.push({
      id: row.id,
      baseUrl: row.url,
      enabled: row.enabled,
      timeoutMs,
      connectTimeoutMs,
    });
  }
  return { ok: true, loaded: { configs, credentials } };
}
