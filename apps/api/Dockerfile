# syntax=docker/dockerfile:1
#
# MATTER LAB Astra lab API image (apps/api). Build context: the repository root (see
# docker-compose.yml and the root .dockerignore). Runs the TypeScript source directly with tsx,
# the same "no build step" approach the npm workspace packages already use with Vite/vitest.
FROM node:24-alpine

# NODE_ENV is deliberately not set to "production": tsx (which runs the TypeScript source
# directly, with no build step) is a runtime dependency of this image, and `npm ci` skips
# devDependencies when NODE_ENV=production is already set, which used to break this image.
ENV MATTERLAB_API_HOST=0.0.0.0 \
    MATTERLAB_API_PORT=8788

WORKDIR /app

# Every workspace's package.json is copied first (even ones this image never runs) so `npm ci`
# sees a lockfile-consistent workspace set; only apps/api and packages/contracts/lab need their
# full source, which is copied afterwards.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/forcefield/package.json packages/forcefield/package.json
COPY packages/quantum/package.json packages/quantum/package.json
COPY packages/reactions/package.json packages/reactions/package.json
COPY packages/contracts/lab/package.json packages/contracts/lab/package.json
RUN npm ci

COPY apps/api apps/api
COPY packages/contracts/lab packages/contracts/lab

RUN addgroup -g 10001 matterlab && adduser -D -u 10001 -G matterlab matterlab
USER matterlab

EXPOSE 8788

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8788/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/api/src/index.ts"]
