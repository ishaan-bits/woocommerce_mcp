# infra/helm

**Nothing here yet — no chart exists in this milestone.** Helm is mandatory for this
assignment, so this is where the chart will live when the deployment milestone starts.

Planned layout:

```text
infra/helm/mcp-gateway/
├── Chart.yaml
├── values.yaml              # shared defaults
├── values-local.yaml        # kind/k3d: NodePorts, 1 replica, tiny resources
├── values-prod.yaml         # TLS Ingress, replicas, resource limits, real Secrets
└── templates/
    ├── gateway/             # Deployment, Service, (later) HPA
    ├── woocommerce-mcp/
    ├── inventory-mcp/
    ├── support-mcp/
    ├── dashboard/
    ├── postgres/            # StatefulSet or Deployment + PVC + Service
    ├── ingress.yaml
    └── secrets.yaml         # rendered only from --set / external values, never literals
```

Design commitments made now, implemented later:

- **One chart, two value files.** Local and production differ only in `values-*.yaml`.
- **No literal secrets in the chart.** Secrets are supplied at install time or via an external
  secret mechanism.
- **Environment separation** lives entirely in values: image tags, replicas, resources, ingress
  class, persistence size.

**Blockers:** Docker, kubectl, Helm, Kind and k3d are not installed on this machine. Nothing in
this directory should be treated as deployable.
