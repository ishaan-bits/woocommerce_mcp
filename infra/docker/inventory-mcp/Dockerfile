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
COPY services/inventory-mcp services/inventory-mcp
RUN npm run build -w @mcp/inventory-mcp

FROM node:26.7-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY services/inventory-mcp/package.json services/inventory-mcp/package.json
COPY services/support-mcp/package.json services/support-mcp/package.json
COPY services/woocommerce-mcp/package.json services/woocommerce-mcp/package.json
RUN npm ci --omit=dev --workspace=@mcp/inventory-mcp --no-audit --no-fund && rm -rf /root/.npm
COPY --from=builder --chown=node:node /build/services/inventory-mcp/package.json services/inventory-mcp/package.json
COPY --from=builder --chown=node:node /build/services/inventory-mcp/dist services/inventory-mcp/dist
USER node
EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8083}/healthz" || exit 1
WORKDIR /app/services/inventory-mcp
CMD ["node", "dist/index.js"]
