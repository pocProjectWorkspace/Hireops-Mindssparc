# HireOps — working notes for Claude

Multi-tenant ATS / hiring platform (MindsSparc). pnpm + Turborepo monorepo:
`apps/api` (Hono + tRPC), `apps/workers` (outbox drains + scheduler), `apps/internal-portal`
(Next.js — recruiter app **and** public candidate pages), `apps/partner-portal`,
`packages/db` (Drizzle, hand-written SQL migrations), `packages/api-types` (zod),
`packages/ai-client` (Claude + ASR clients), `packages/ui`.

**Current client: Solenis GBS India** (pilot). Demo to Solenis US leadership on **8 Oct 2026**.
Start every session by reading the latest handoff: `docs/new-set/HANDOFF-29sep-solenis-demo.md`.

## Environment
- Node 22 for every pnpm/node command: `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`
  (the default shell is Node 20 and pnpm fails).
- Don't run full `pnpm typecheck` in an agent (~11 min). Use
  `npx tsc --noEmit -p <app>/tsconfig.json` + scoped eslint/prettier. Run api tests one file at a
  time: `cd apps/api && NODE_ENV=test DB_POOL_MAX=3 npx vitest run test/<file>`. The test DB is the
  shared old-staging DB (a deployed worker drains it).
- The repo is under iCloud-synced Desktop: ignore and never stage `* 2.ts`-style duplicates. Stage
  explicit paths.
- Migrations: `pnpm db:migrate` uses `DIRECT_URL` (session pooler, 5432). Railway never migrates —
  apply migrations **before** deploying code that needs them, on both old staging and Solenis.
- RLS gate: `pnpm db:lint:rls`.

## Deploy topology (Solenis stack)
- Portal: Vercel project `solenis-portal` (linked from `apps/internal-portal/.vercel`) →
  solenis.hireops-ai.com, auto-deploys on merge to main.
  Needs `NEXT_PUBLIC_API_BASE` = bare api host **and** `NEXT_PUBLIC_API_BASE_URL` = host + `/trpc`.
  After changing either, force a clean build (Turbo cache ignores them — see handoff §4).
- API + workers: Railway project `welcoming-sparkle` (id `3d34fa66-2bbb-491b-9ebe-2106e1055bf0`),
  no git source — `railway up --service api|workers` from a **clean checkout of main**.
- Old staging stack (hireops-portal + separate Supabase) still exists; don't confuse the two.

## Git / GitHub rules
- Agents may commit on a feature branch; **never push or merge** (hook-enforced). The human
  pushes as `pocProjectWorkspace` (see handoff §4 for the one-line push command).
- End commit messages with the Co-Authored-By line; PR bodies with the Claude Code footer.

## Product stances (don't regress)
- AI interview + notetaker produce **evidence, not scores**. No hire/no-hire, no rating, no
  inference from voice/face/tone. The human panel decides via the scorecard.
- Candidate consent is enforced by the system before any recording is accepted.
- Market intel: every figure carries source, date, sample size; sources are never blended; the AI
  never invents a market number.
- Candidate-facing disclosure copy is versioned — any wording change bumps the version.

## Key docs (docs/new-set/)
- `HANDOFF-29sep-solenis-demo.md` — latest state, demo assets, traps, open items
- `SOLENIS-demo-audit-26sep.md` — original gap audit
- `ai-interview-build-plan.md` — N3/N4 notetaker + AI interview design
- `TEAMS-recording-options.md` — automatic Teams capture options (Graph vs bot)
- `market-intel-feasibility-build-plan.md`, `MARKET-DATA-platform-sources-plan.md`,
  `MARKET-INTEL-source-verification.md` — market intel
- `scripts/solenis-stage-transcript.py` — stage notetaker + AI rounds via the live API
