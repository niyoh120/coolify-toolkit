# Build stage: install exact lockfile deps and build web + server bundles.
FROM node:24.19.0-alpine AS build
WORKDIR /app
ENV NPM_CONFIG_IGNORE_SCRIPTS=true
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig*.json vite.config.ts vitest.config.ts drizzle.config.ts biome.json ./
COPY scripts ./scripts
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build:web && npm run build:server

# Runtime: non-root, /data volume, no build tooling.
FROM node:24.19.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/toolkit.db
ENV WEB_DIST=/app/dist/web
RUN addgroup -S toolkit && adduser -S toolkit -G toolkit && mkdir -p /data && chown toolkit:toolkit /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
USER toolkit
VOLUME ["/data"]
EXPOSE 8080
# Healthcheck uses the toolkit's own liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
