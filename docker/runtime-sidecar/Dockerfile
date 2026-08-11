# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS builder
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/simulation/package.json packages/simulation/package.json
COPY packages/storage-gateway/package.json packages/storage-gateway/package.json
COPY packages/supervisor/package.json packages/supervisor/package.json
COPY packages/validator/package.json packages/validator/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY apps/web-ui/package.json apps/web-ui/package.json
RUN npm ci
COPY packages packages
COPY apps/web-ui apps/web-ui
COPY scripts scripts
COPY vendor vendor
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="InfraEnv Runtime Sidecar" \
      org.opencontainers.image.description="Local S2 behavioral simulation runtime; not a real HPC cluster" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    INFRAENV_HOST=0.0.0.0 \
    INFRAENV_PORT=8080 \
    INFRAENV_UI_ROOT=/opt/infraenv/ui \
    INFRAENV_PROGRESS_FILE=/data/progress.jsonl
WORKDIR /opt/infraenv
COPY --from=builder --chown=node:node /src/node_modules ./node_modules
COPY --from=builder --chown=node:node /src/packages ./packages
COPY --from=builder --chown=node:node /src/apps/web-ui/dist ./ui
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "/opt/infraenv/packages/runtime/dist/server.js"]
