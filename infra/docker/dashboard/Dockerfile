FROM node:26.7-alpine AS deps
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY services/inventory-mcp/package.json services/inventory-mcp/package.json
COPY services/support-mcp/package.json services/support-mcp/package.json
COPY services/woocommerce-mcp/package.json services/woocommerce-mcp/package.json
RUN npm ci --no-audit --no-fund && rm -rf /root/.npm

FROM deps AS builder
COPY tsconfig.base.json tsconfig.base.json
COPY apps/dashboard apps/dashboard
RUN npm run build -w @mcp/dashboard

FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime
USER root
RUN mkdir -p /etc/nginx/api-proxy && chown -R nginx:nginx /etc/nginx/api-proxy /etc/nginx/conf.d
COPY --chown=nginx:nginx infra/docker/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=nginx:nginx infra/docker/dashboard/40-api-proxy.sh /docker-entrypoint.d/40-api-proxy.sh
COPY --from=builder --chown=nginx:nginx /build/apps/dashboard/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:8080/" || exit 1
