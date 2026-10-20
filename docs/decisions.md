# Architecture Decisions

Short decision records: **Context → Decision → Alternatives → Trade-offs**.
Anything marked *planned* has not been built yet; these are commitments about *how* it will be
built when it is.

---

## D1 — Single monorepo with npm workspaces

**Context.** Six deployable/deliverable units (gateway, dashboard, three MCP servers, shared
types) built by one person, on a machine with npm only.

**Decision.** One repository, `package.json` `workspaces: ["apps/*", "services/*", "packages/*"]`.

**Alternatives.**
- Separate repos per service — cleaner ownership boundaries for teams, but multiplies CI,
  versioning and onboarding cost; a beginner would spend more time on plumbing than MCP.
- pnpm / Yarn workspaces — faster and stricter linking, but neither is installed, and
  corepack is absent; installing a second package manager conflicts with the ₹0 /
  don't-install-tools constraint for this milestone.

**Trade-offs.** One `node_modules` tree and one version set (simpler, occasionally forcing
coordinated upgrades) in exchange for atomic cross-package refactors. Published as private
packages only, so accidental publication is impossible.

---

## D2 — TypeScript everywhere backend-side, React + Vite for the UI

**Context.** MCP's official server/client libraries are TypeScript-first; the dashboard is a
browser SPA.

**Decision.** `strict` TypeScript for gateway and all MCP servers, React 19 + Vite 8 for the
dashboard, one shared `tsconfig.base.json`.

**Alternatives.** Python MCP SDK (fine, but splits the stack and the dashboard anyway needs
TS); plain JavaScript (faster to start, but tool schemas and audit-record shapes are exactly
where type errors hide until production).

**Trade-offs.** Compilation step and type verbosity up front; runtime surprises and
schema drift down. `strict` plus `noUncheckedIndexedAccess` is deliberately on.

---

## D3 — Official `@modelcontextprotocol/sdk` (TypeScript)

**Context.** Every MCP server and the gateway's upstream client need protocol conformance.

**Decision.** Use the official SDK (currently `^1.32.1`) for `McpServer`, the Streamable HTTP
transport, and `Client` for upstream connections. Hand-write JSON-RPC only in the docs.

**Alternatives.** Rolling our own JSON-RPC/HTTP layer — educational, but reimplements
`initialize` handshake, session ids, schema validation and version negotiation, i.e. exactly
the parts an interviewer will ask about and exactly the parts that break subtly.

**Trade-offs.** We inherit a third-party dependency and its release cadence. Acceptable: it is
the reference implementation, MIT-licensed, and pinned with a caret range we verified against
the registry (`zod ^4` satisfies its peer range).

---

## D4 — Streamable HTTP transport (not stdio, not HTTP+SSE)

**Context.** Everything must run as networked services inside Kubernetes.

**Decision.** All MCP endpoints speak Streamable HTTP at `/mcp`.

**Alternatives.**
- *stdio* — simplest possible local setup, but a Pod cannot "spawn a child across the cluster";
  unusable as a remote multi-tenant endpoint.
- *HTTP + SSE* (two endpoints) — the deprecated predecessor; extra endpoint, extra proxy
  configuration, no benefit.

**Trade-offs.** We must handle sessions, concurrent POSTs and reverse-proxy buffering (nginx
`proxy_buffering off` for SSE) — problems stdio never gives you. Those are also the problems
worth knowing for an FDE interview.

---

## D5 — The gateway always publishes *qualified* tool names

**Context.** Upstream-local names must stay `list_products` etc. (assignment), but two
upstreams can expose the same local name.

**Decision.** Publish `<upstreamId>_<localName>` (e.g. `woocommerce_list_products`) always,
never only-on-collision; resolve by matching the leading segment against the known upstream
ids.

**Alternatives.**
- *Bare names until a collision occurs* — shorter names, but the published tool list changes
  shape whenever an upstream is enabled/disabled, breaking cached clients and docs.
- *Only rename the losers of a collision* — same instability, plus a silent rename.

**Trade-offs.** Slightly more verbose tool names for every call. In exchange: deterministic,
reversible, greppable, and collision-proof by construction. Downside accepted: names are
64-ish chars of headroom, well inside MCP's name limits.

---

## D6 — Gateway hosts two surfaces: `/mcp` and `/api/*`

**Context.** The dashboard needs admin operations that MCP has no primitives for.

**Decision.** One Express app, two route families: `/mcp` (MCP only) and `/api/*` (REST for
the UI), sharing auth, tool registry and audit writer. Tools are *executed* only on the `/mcp`
path.

**Alternatives.**
- *Dashboard speaks MCP for everything* — uniform, but forces admin actions into fake "tools",
  which pollutes the tool list an LLM sees.
- *Separate backend process* — cleaner separation, but a second deployment, second auth stack
  and second config surface for no isolation benefit at this scale.

**Trade-offs.** Two API styles to document and test in one service. Mitigated by the
invariant: one execution path, one audit writer.

---

## D7 — PostgreSQL for application data

**Context.** Users, hashed API keys, upstream config and an audit log must survive restarts
and be queryable from Kubernetes.

**Decision.** PostgreSQL via the official `pg` driver, official `postgres` image, PVC-backed
in-cluster.

**Alternatives.**
- *SQLite* — zero operational cost, but one file per Pod, no safe multi-replica story, and the
  assignment names PostgreSQL.
- *No database / JSON file* — instantly loses audit integrity on restart.

**Trade-offs.** A stateful service to run (backups, migrations, credentials). Accepted because
the audit log is a security control, and a control that can be deleted by a Pod restart is not
a control. Local dev can still point `DATABASE_URL` at a throwaway container later.

---

## D8 — PostgreSQL schema decisions: API keys are stored as hashes

**Context.** Two users, individually revocable keys, no plaintext secrets at rest.

**Decision.** Generate a high-entropy key (≥ 32 random bytes, shown to the user exactly once),
store `sha256(key + API_KEY_PEPPER)` plus a short `key_prefix` for display ("abcd1234…"),
compare in constant time. Revocation = flip `revoked_at`.

**Alternatives.**
- *bcrypt/argon2id* — stronger against brute force, but deliberately slow, and a 256-bit random
  key has no dictionary to attack; slow hashing mainly protects weak passwords, not random
  tokens. (Peer projects: GitHub, Stripe and many API-key systems use a fast hash on high
  entropy keys.)
- *Encrypt and store* — enables recovering the key, which defeats the point.

**Trade-offs.** If the database *and* the pepper leak, keys are crackable only if the keys were
low-entropy — they are not. Pepper lives in a Kubernetes Secret, separate from the database
credentials, so one stolen backup is not enough. *Planned, not implemented.*

---

## D9 — Express 5 as the HTTP layer

**Context.** The MCP SDK ships Express-compatible Streamable HTTP plumbing; the gateway also
needs plain REST routes.

**Decision.** Express 5 (`^5.3.0`) for both surfaces.

**Alternatives.** *Hono* (also bundled with the SDK, faster, smaller — good, but a second
framework to learn alongside everything else); *Fastify* (excellent, more plugin ceremony).

**Trade-offs.** Express is the most documented Node framework, which matters when a beginner
has to explain the code in an interview. We accept older-style middleware ergonomics.

---

## D10 — Inventory and Support are separate processes, not gateway code

**Context.** It would be far faster to hardcode two more tool sets inside the gateway.

**Decision.** They are independent MCP servers; the gateway only knows their base URLs. Enabling
one is configuration, not a gateway deploy.

**Alternatives.** Hardcoded in-gateway tools — fewer moving parts, but the "gateway" degrades
into "the application", and the required property *continued operation when an upstream fails*
becomes meaningless because an upstream cannot fail independently.

**Trade-offs.** More Pods, more configs, more network hops. Bought deliberately: independent
failure domains and a genuinely generic gateway.

---

## D11 — No LLM and no AI API keys yet

**Context.** The assignment forbids paid/mandatory services and requires no key at this stage.

**Decision.** Milestone 0–8 contain no model calls. The chat agent (milestone 9) will use a
free tier (Groq) or a local model (Ollama) and will call tools through the ordinary gateway
path with its own principal.

**Alternatives.** Wiring a model in early — makes demos flashy while the security and routing
foundation is still untested.

**Trade-offs.** Later, less impressive-looking early milestones. Worth it: a chat demo over an
unaudited, unauthenticated gateway is the failure mode this assignment is designed to expose.

---

## D12 — Local Kubernetes first (kind or k3d), Helm for both environments

**Context.** Budget ₹0; final deployment must be on Kubernetes with Helm, local *and*
production value variants.

**Decision.** Local cluster via **kind** (preferred) or **k3d**, one Helm chart, two value
files: `values-local.yaml` (NodePort ingress, 1 replica, tiny resources) and `values-prod.yaml`
(TLS, replicas, resource limits, real Secrets). Cluster creation happens in a later milestone —
Docker/kubectl/Helm/Kind are **not installed** today.

**Alternatives.**
- *minikube* — also free; kind integrates more cleanly with Docker-based image loading.
- *Raw YAML for prod, Helm for local* — rejected: two sources of truth will drift.
- *Paid managed cluster* — violates the budget constraint.

**Trade-offs.** Local clusters are not production-shaped (no autoscaling, no real TLS), so
`values-prod.yaml` must be reviewed carefully before any real use. Accepted: the alternative
violates the constraints.

---

## D13 — Version pinning policy

**Context.** "Do not pin unverified or incompatible versions."

**Decision.** Caret ranges on major versions that were verified present and mutually
compatible against the npm registry on 2026-10-21 (`npm view …`): TypeScript 5.9.3 (not 6/7 —
5.x is what current tutorials, the SDK's examples and Stack Overflow answers assume),
`@modelcontextprotocol/sdk` 1.32.1, Express 5.3.0, zod 4.6.7 (satisfies the SDK peer range
`^3.25 || ^4.0`), React 19.3.1, Vite 8.3.4 with `@vitejs/plugin-react` 6.1.2 (peer `vite ^8`),
`pg` 8.23.1. Lockfile committed so installs are reproducible.

**Trade-offs.** Caret ranges can pull minor upgrades later; the lockfile is the real guarantee.
Exact pins would make upgrades manual and noisy for a solo project.

---

## D14 — `services/woocommerce-mcp` does not depend on `@mcp/shared`

**Context.** `packages/shared` lists the five WooCommerce tool names for the gateway to
consume. The natural instinct is to import that list from the server so the names cannot
drift. npm workspaces do not, however, run workspace scripts in topological order, so a
cross-package import would require `packages/shared/dist` to exist *before*
`services/woocommerce-mcp` typechecks — a build-order trap for a beginner-friendly repo.

**Decision.** `services/woocommerce-mcp` declares **no** dependency on `@mcp/shared`. Tool
names, input schemas and descriptions live in `src/tool-schemas.ts` / `src/mcp-server.ts`.
`packages/shared` remains the gateway-facing contract; keeping the two lists in sync is a
manual, documented step for Milestone 2 (the gateway will compare names at discovery time).

**Alternatives.** (a) Cross-import with a `prepack`/`prepare` build chain — extra machinery
and a confusing failure mode (`dist` missing) for two consuming sites. (b) Move the canonical
tool *definitions* (zod schemas) into `shared` — premature: the gateway needs names and JSON
Schema, not this server's zod internals.

**Trade-offs.** The two lists can drift; accepted for Milestone 1 and mitigated in Milestone 2
by a discovery-time assertion rather than a compile-time import.

---

## D15 — Stateful Streamable HTTP sessions (one `McpServer` per session)

**Context.** The SDK's Streamable HTTP transport supports a stateful pattern (server-generated
`Mcp-Session-Id`, sessions kept in a map) and a stateless pattern (`sessionIdGenerator:
undefined`, one shared server).

**Decision.** Stateful, mirroring the SDK's shipped `simpleStreamableHttp` example: each
initialize creates a transport **and** an `McpServer`, sessions are keyed by id, unknown
sessions get `404 -32001`, non-initialize POSTs without a session get `400 -32000`, capacity is
capped (default 100, `503` beyond), idle sessions are swept (default 30 minutes), and shutdown
drains (`503 "Server is shutting down"`) before closing transports.

**Alternatives.** Stateless — simpler and horizontally friendly, but no per-client SSE stream
and a weaker fit for the gateway's per-client session/audit story in Milestone 2.

**Trade-offs.** Session state lives in process memory (no cross-replica sharing yet); the
sweeper and capacity cap exist so a leak is bounded. Revisit when replicas > 1.

---

## D16 — Node's built-in test runner and native type stripping (no jest/vitest)

**Context.** Tests must run with zero extra tooling, and the SDK is ESM-first.

**Decision.** `node --test "test/**/*.test.ts"` runs TypeScript sources directly via Node's
native type stripping, so the engines floor is **Node ≥ 23.6.0** (raised from 20.19). Source
and tests import with explicit `.ts` specifiers; `tsconfig.base.json` sets
`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` so `tsc` builds still emit
`.js` imports. Constraints: no enums/namespaces/parameter properties (non-erasable syntax).

**Alternatives.** vitest (great DX, but a second toolchain and dependency tree); jest +
ts-jest (CJS friction with the ESM SDK); compile-then-test (slower loop, two configs).

**Trade-offs.** No watch UI or coverage dashboard; a higher Node floor. Accepted: one
toolchain, zero extra dependencies, tests exercise the same files that ship.

---

## D17 — Basic auth header only; plain-HTTP stores are out of scope

**Context.** WooCommerce's own `WC_REST_Authentication` (verified in WooCommerce core source)
only runs `perform_basic_authentication()` when `is_ssl()` is true. Over plain HTTP it falls
back to OAuth 1.0a one-legged signing. Query-string `consumer_key`/`consumer_secret` are a
fallback *within* the SSL path, not a plain-HTTP mechanism.

**Decision.** The client sends credentials **only** as an HTTP Basic `Authorization` header
over the `WOOCOMMERCE_STORE_URL` the operator supplies, refuses to put credentials in URLs,
warns at startup when the store URL is `http://`, and recommends HTTPS. OAuth 1.0a signing is
**not implemented**; documenting the gap beats shipping an unverifiable signature scheme.

**Alternatives.** Query-string credentials — secrets in URLs, logs and proxies; rejected.
OAuth 1.0a — correct for plain HTTP but a substantial, hard-to-verify-in-CI addition;
recorded as future work if a plain-HTTP store is ever required.

**Trade-offs.** Local plain-HTTP WordPress installs will get HTTP 401 until the store is put
behind HTTPS (or the operator terminates TLS in front of it). Honest failure with a pointed
message beats silent credential leakage.
