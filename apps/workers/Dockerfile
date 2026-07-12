# syntax=docker/dockerfile:1
#
# apps/workers — the polling-loop process (outbox drain, scheduler ticks,
# agent-run drain, etc.). NO HTTP server: it's a long-lived loop, so the
# Fly app declares no [http_service] and is kept to exactly ONE machine
# (Wave 1 singleton assumption — see apps/workers/fly.toml).
#
# Same monorepo strategy as apps/api's Dockerfile (see that file for the
# full rationale): build context is the REPO ROOT, workspace deps are
# consumed as TS source, the process runs under `tsx`.
#
# Build from the repo root:
#   docker build -f apps/workers/Dockerfile -t hireops-workers .

# ---- base: Node 22 LTS + pnpm via corepack ----
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /repo

# ---- build: install the whole workspace, then prune to @hireops/workers ----
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter=@hireops/workers --legacy deploy --prod=false /out

# ---- runtime: only the pruned deployment ----
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Invoke tsx directly (the "start" script is `tsx src/index.ts`) rather than
# via `pnpm start`, so container cold-start doesn't trigger a corepack pnpm
# download. The worker has no listening port; health is inferred from the
# process staying up (Fly restarts a crashed machine). src/lib/env.ts
# dotenv-loads a repo-root .env that's absent in the image — dotenv no-ops
# and Fly secrets (process.env) are the sole config source.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
