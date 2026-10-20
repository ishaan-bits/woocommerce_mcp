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

**Blocker:** Docker is not installed on this machine, so images cannot be built or verified
yet. This directory is created now only so the repository layout matches the documented
architecture. Do not describe any image as "working".
