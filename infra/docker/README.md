# infra/docker

**Nothing here yet — no Dockerfiles exist in this milestone.**

This directory will hold one Dockerfile (plus small supporting files) per deployable:

```text
infra/docker/
├── gateway/Dockerfile
├── dashboard/Dockerfile        # multi-stage: build Vite bundle, serve with nginx
├── woocommerce-mcp/Dockerfile
├── inventory-mcp/Dockerfile
├── support-mcp/Dockerfile
└── .dockerignore
```

Planned rules (decided in advance so images are consistent):

- Multi-stage builds: builder stage with Node, final stage with only `production` deps.
- Run as a non-root user.
- No secrets baked in — secrets arrive at runtime from Kubernetes Secrets.
- One base image family (official `node:<lts>-alpine`), pinned by tag.

**Status (updated 2026-10-21):** Docker (CLI + engine via Colima) **is** installed, so
images *could* now be built — but no Dockerfile exists yet (Milestone 6) and no image has
been built or verified. This directory still only explains the planned layout. Do not
describe any image as "working".
