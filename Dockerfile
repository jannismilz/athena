# One multi-stage build, one target per service.
#
# Dependencies are installed once in a shared stage so the three service images
# share layers, and the source is copied last so a code change does not
# reinstall node_modules.

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until dependencies actually change.
COPY package.json bun.lock ./
COPY packages/core/package.json       packages/core/
COPY packages/mcp/package.json        packages/mcp/
COPY packages/indexer/package.json    packages/indexer/
COPY packages/dashboard/package.json  packages/dashboard/
RUN bun install --frozen-lockfile --production

FROM deps AS source
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages

# Bun runs TypeScript directly, so there is no build step and no dist/ to ship.
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini tzdata \
 && addgroup -g 10001 athena \
 && adduser -u 10001 -G athena -s /bin/sh -D athena
ENV NODE_ENV=production
USER athena
ENTRYPOINT ["/sbin/tini", "--"]

FROM runtime AS mcp
COPY --from=source --chown=athena:athena /app /app
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "packages/mcp/src/main.ts"]

FROM runtime AS indexer
COPY --from=source --chown=athena:athena /app /app
ENV PORT=8081
EXPOSE 8081
CMD ["bun", "packages/indexer/src/main.ts"]

FROM runtime AS dashboard
COPY --from=source --chown=athena:athena /app /app
ENV PORT=8082
EXPOSE 8082
CMD ["bun", "packages/dashboard/src/main.ts"]
