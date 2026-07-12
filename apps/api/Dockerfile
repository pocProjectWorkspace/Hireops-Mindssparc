# syntax=docker/dockerfile:1
#
# apps/api — Hono + tRPC HTTP server (Fly.io, per ADR §3.5: long-running
# Node process, not serverless). Build context is the REPO ROOT, not this
# directory, because this is a pnpm workspace and the api consumes its
# @hireops/* dependencies as TypeScript SOURCE (each package's "main"
# points at src/index.ts; there is no build/dist step). The app runs under
# `tsx` in dev and prod alike (see the "start" script), so the runtime
# image ships the TS sources + tsx rather than compiled JS.
#
# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t hireops-api .
#
# Monorepo strategy: a full `pnpm install` populates the content-addressable
# store, then `pnpm deploy` prunes the workspace to just @hireops/api and
# its transitive deps into a self-contained /out (its own node_modules with
# every @hireops/* dep copied in as source). --legacy is required because
# our workspace packages are consumed as source, not injected/built (pnpm
# v10+ otherwise refuses to deploy without inject-workspace-packages).
# --prod=false keeps tsx, which lives in devDependencies but IS the runtime.

# ---- base: Node 22 LTS + pnpm via corepack (pinned by root packageManager) ----
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /repo

# ---- build: install the whole workspace, then prune to @hireops/api ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter=@hireops/api --legacy deploy --prod=false /out

# ---- runtime: only the pruned deployment ----
FROM base AS runtime
ENV NODE_ENV=production
# PORT is read by src/index.ts (process.env.PORT ?? 3001). Fly's
# internal_port must match this — 8080 is the Fly convention.
ENV PORT=8080
WORKDIR /app
COPY --from=build /out ./
EXPOSE 8080
# Invoke tsx directly (the "start" script is `tsx src/index.ts`) rather than
# via `pnpm start`, so container cold-start doesn't trigger a corepack pnpm
# download over the network. bootstrap.ts tries to dotenv-load a repo-root
# .env; in the image that path is absent and dotenv no-ops, so process.env
# (Fly secrets) is the sole config source.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
