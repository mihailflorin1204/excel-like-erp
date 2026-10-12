# syntax=docker/dockerfile:1
# One Dockerfile, two images: `--target api` (Node) and `--target web` (nginx). docker-compose.yml builds both.

# ---- build: install everything once, then build the API bundle and the web app ----
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.34.7

# Dependency layer: only re-runs when a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @erp/api build && pnpm --filter @erp/web build

# ---- api: just Node and one bundled file (dependencies are inside it) ----
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3001
COPY --from=build /app/apps/api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1
CMD ["node", "--enable-source-maps", "dist/server.mjs"]

# ---- web: static files served by nginx, which also forwards /api to the api container ----
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
