# HireOps

Enterprise ATS platform for the Kyndryl GCC POC. Full hiring lifecycle: recruitment, onboarding, offboarding, with Workday integration.

## Status

Pre-development scaffold. No product code yet. Design documents live in `/docs`.

## Tech stack

- **Monorepo:** pnpm workspaces + Turborepo
- **Language:** TypeScript 5.x (strict)
- **Runtime:** Node 22 LTS
- **Frontends:** React + Vite (internal, candidate, partner portals); Next.js (careers site)
- **API:** Node + Hono + tRPC
- **Workers:** Node + BullMQ
- **Database:** Postgres (host TBD — Supabase / Neon / RDS)
- **Search:** Postgres FTS for v1, Typesense later
- **AI / LLM:** Anthropic Claude via thin abstraction in `packages/ai-client`
- **Workday integration:** Custom SOAP + REST in `packages/workday-client`

## Getting started

```bash
nvm use
pnpm install
pnpm build
pnpm lint
pnpm typecheck
```

## Workspace layout

- `apps/` — deployable applications (frontends, API, workers)
- `packages/` — shared libraries (UI, types, AI client, Workday client, DB, config)
- `docs/` — design documents (requirements, architecture, ADRs, wireflows)

## Documentation

See `/docs` for:

- `requirements.md` — what we're building
- `architecture.md` — how we're building it
- `workday-adr.md` — Workday integration decision record
- `partner-wireflows.md` — HR partner portal specification

## Next steps

After this scaffold is committed, the four design documents above will be added to `/docs`. Feature work begins after design review.
