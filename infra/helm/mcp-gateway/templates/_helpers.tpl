{{/*
Chart name in label form.
*/}}
{{- define "mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels (release identity). Component-specific labels are added next to
these at each call site.
*/}}
{{- define "mcp.labels" -}}
helm.sh/chart: {{ include "mcp.chart" . }}
app.kubernetes.io/part-of: mcp-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels for one component:
  {{ include "mcp.selectorLabels" (dict "root" . "name" "gateway") }}
*/}}
{{- define "mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/*
Effective Secret name: operator-supplied existingSecret wins, otherwise the
chart-created one. Every workload references secrets through this helper.
*/}}
{{- define "mcp.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" .Release.Name -}}
{{- end -}}
{{- end -}}

{{/*
Pod security context for the non-root workloads (gateway, MCP servers,
dashboard, mock store). PostgreSQL is deliberately excluded: the official
image starts as root to initialise the data directory and then drops the
server process to the postgres user — see infra/helm/README.md.
*/}}
{{- define "mcp.podSecurityContext" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/*
Container security context for the non-root workloads.
*/}}
{{- define "mcp.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: ["ALL"]
{{- end -}}
