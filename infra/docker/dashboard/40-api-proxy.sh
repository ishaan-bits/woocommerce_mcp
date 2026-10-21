#!/bin/sh
set -eu

conf=/etc/nginx/api-proxy/00-api-proxy.conf

if [ -n "${GATEWAY_UPSTREAM:-}" ]; then
  cat >"$conf" <<EOF
location /api/ {
    proxy_pass ${GATEWAY_UPSTREAM};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
}
EOF
else
  cat >"$conf" <<'EOF'
location /api/ {
    default_type application/json;
    return 503 '{"error":"gateway proxy not configured (set GATEWAY_UPSTREAM, e.g. http://gateway:8080)"}';
}
EOF
fi
