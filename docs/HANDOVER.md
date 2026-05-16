# HireOps — Handover Document for Continuing Sessions

**Purpose:** This document is pasted at the start of any new Claude conversation about HireOps. It compresses the full state of the project so a fresh Claude can pick up cleanly without the user re-explaining every decision.

**How to use:** Paste this entire document as the first message in a new conversation. Then the user will tell Claude what they want to do next. Claude reads this, internalises it, then engages.

**Last updated:** 9 May 2026, after the Tier 1+2 requirements refinement (commit 957e093).

---

## 1. What HireOps is

HireOps is a **multi-tenant SaaS ATS** for enterprise hiring — full lifecycle (recruitment + onboarding + offboarding), Workday integration as HRIS-of-record where applicable, partner sourcing as a first-class capability. Closest commercial comparables: Ashby and Greenhouse.

**Business model:** the current build is funded by a paid POC engagement with **Kyndryl's GCC**, which becomes Tenant #1 in production after POC success. The platform is then sold to additional enterprise tenants (other GCCs, Indian enterprises, SE-Asian high-volume hirers).

**Technical scale (Kyndryl-defined launch volume):**
- 300 hires/month, ~9-15K applications/month, ~75 interviews/day peak 150
- 50-80 concurrent recruiters, 200+ panel members, 150-300 concurrent partner users
- ~60% of submissions via HR partners, ~25% direct (career site/inbound), ~15% referrals
- POC timeline: 24 weeks, three waves

**The user is building this as their product** (not as a Kyndryl-internal tool). Kyndryl's POC funds the build but HireOps is multi-tenant from day one.

---

## 2. What's been built

### 2.1 Repository

Located at `~/Desktop/workspace/hireops` on the user's Mac. Monorepo: pnpm 11 + Turborepo + Node 22 LTS + TypeScript 5.x strict + ESLint 9 flat + Prettier (100-char width).

**6 apps:**
- `apps/internal-portal` (React + Vite) — recruiter / HM / panel / HR Ops / People Ops / IT / Admin
- `apps/candidate-portal` (React + Vite) — candidates and post-hire employees
- `apps/partner-portal` (React + Vite) — empanelled HR partners
- `apps/careers-site` (Next.js SSR) — public job board
- `apps/api` (Node + Hono + tRPC) — application API
- `apps/workers` (Node + BullMQ) — async work (Workday sync, BGV, parsing, reconciliation)

**6 packages:**
- `packages/ui` — shared React component library (shadcn-based, Storybook)
- `packages/types` — shared domain models + API contracts
- `packages/ai-client` — thin abstraction over LLM providers (Anthropic primary, Bedrock fallback)
- `packages/workday-client` — SOAP + REST wrapper for Workday
- `packages/db` — Postgres schema, migrations, RLS, queries
- `packages/config` — shared runtime config + env loading

All `pnpm typecheck && pnpm lint && pnpm build` passing. Each app/package has only stub `src/index.ts` — no product code yet.

### 2.2 Design documents (in `/docs/`)

| File | Lines | Purpose |
|---|---|---|
| `requirements.md` | ~950 | What we're building — capabilities, personas (13 tenant-facing + 1 platform admin), lifecycle, partner sourcing, recruitment/onboarding/offboarding, Lovable feature audit, POC scope |
| `architecture.md` | ~1,038 | How we're building it — data model, Workday integration overview, partner architecture, security, DPDPA, sizing, deployment, AI |
| `workday-adr.md` | 497 | ADR-001: Workday integration architecture (SOAP+REST hybrid, ISU credentials, BP polling, idempotency, reconciliation) |
| `multi-tenancy-adr.md` | 996 | ADR-002: tenant isolation, identification, RLS composition, configuration model, integration credentials, tenant onboarding |
| `partner-wireflows.md` | ~1,180 | HR partner portal specification (empanelled portal screens, ad-hoc email-intake, Kyndryl admin touchpoints) |
| `partner-data-model.md` | 406 | Consolidated partner schema — 13 tables with full SQL, FKs, indexes, RLS policies |
| `competitive-landscape.md` | ~240 | Market survey: Ashby (visual benchmark), Greenhouse (rigour), Workday Recruiting (competitive threat), India platforms (Darwinbox/Ceipal/Naukri RMS) |

### 2.3 Internal artefacts (in `/docs/internal/`)

| File | Purpose |
|---|---|
| `system-map.md` | Structured model of the system — personas, lifecycle stages, data entities, external integrations, workspace map |
| `wave-1-backlog.md` | 158 tasks across 12 tracks; critical path documented |
| `open-questions.md` | All 8 contradictions resolved; 13 gaps resolved (gap #11 still pending Workday BP step audit, gap #13 resolved by ADR-002); 8 Kyndryl POC-onboarding items reframed as configuration not blockers |

### 2.4 Git history

```
957e093 docs: apply Tier 1 + Tier 2 refinements to requirements.md
1a50be7 docs: apply ADR-002 implications across schema and backlog
e8faf20 docs: add Multi-Tenancy ADR (ADR-002)
16041c0 docs: reframe HireOps as multi-tenant SaaS with Kyndryl as first POC customer
a900d3a docs: add competitive landscape and design benchmarks
6de3cb1 docs: resolve contradictions and gaps from internal review pass
2dfd17c chore: initial repository scaffold
```

Clean linear history. Every commit is a coherent unit.

---

## 3. Decisions locked (do not re-litigate)

### 3.1 Product positioning
- **Multi-tenant SaaS product**, Ashby/Greenhouse business model (not Workday-per-customer)
- Kyndryl is Tenant #1 in production, paid POC engagement funds the platform build
- One codebase, one production deployment, many tenants
- Configuration replaces customisation — every customer-specific need maps to tenant-configurable platform features

### 3.2 Architectural foundation
- **Multi-tenancy:** shared database, shared schema, `tenant_id` column on every domain table, Postgres RLS as outermost predicate composing with role scoping (per ADR-002)
- **Tenant identification:** subdomain primary (`{slug}.hireops.app`) + JWT `tid` claim authoritative
- **Per-tenant integration credentials:** envelope encryption with per-tenant DEK wrapped by KMS master KEK
- **Tenant onboarding:** 8-step product workflow, resumable, DPDPA-aware deletion
- **Region:** ap-south-1 (Mumbai) for POC, multi-region-ready architecture, single-region deployment

### 3.3 Workday integration
- **SOAP + REST hybrid** per ADR-001 (SOAP for staffing transactions, REST + WQL for reads)
- ISU credentials with WS-Security; OAuth Client Credentials for REST
- Pre-Hire fires automatically on offer-accept; Hire fires automatically on Day 1 (Day-1 cron scheduler at 00:00 IST) — neither is human-triggered
- Workday has **no native outbound webhooks** — every "real-time" sync is polling
- Daily reconciliation at 03:00 IST, drift threshold: >5 divergences in 7 days → P2 PagerDuty
- Idempotency via deterministic `business_key` per sync job

### 3.4 Partner ownership rules
- **Three windows:** 90-day req-bound, 180-day speculative, 60-day ad-hoc
- **First-valid-submission wins** — database timestamp at millisecond resolution
- **Cross-req attribution by default** — MSAs MAY narrow to req-only via `partner_msa.exclusivity_scope='req_only'`
- **Empanelled wins disputes** with ad-hoc partners regardless of timestamp
- **Database-level guarantee:** partial unique index on `candidate_ownership_claims (tenant_id, person_id, requisition_id) WHERE status = 'active'`
- **Synchronous dedup** before application commit — atomic INSERT ON CONFLICT

### 3.5 Tooling and runtime
- **Postgres host:** Supabase managed
- **API runtime:** Fly.io
- **Object storage:** S3 + KMS
- **LLM primary:** Anthropic Claude direct (Bedrock fallback)
- **E-signature:** DocuSign (Adobe Sign as alternative)
- **Calendar:** Google + Outlook both
- **Interview platform:** Zoom
- **Career site framework:** Next.js SSR
- **Mobile strategy:** PWA-quality responsive web (no native app for POC)

### 3.6 Wave structure (24 weeks total)
- **Wave 1 (weeks 1-11)** — End-to-end thin slice on synthetic tenant. 10 hires of which 6 via partner. Real Workday, real BGV, 3 friendly empanelled vendors.
- **Wave 2 (weeks 12-18)** — Volume & polish. 50 hires/month stress test. 10-15 active partners. Bulk operations, AI scoring + bias shield real, WhatsApp/SMS, job-board posting, reporting suite.
- **Wave 3 (weeks 19-24)** — Production readiness. 300 hires/month sustained for 1 month. 10-15 empanelled vendors active (full 20-30 panel ramps over Q2 post-POC). Pen test, DPDPA audit, DR drills.

### 3.7 Testability thresholds (added in Tier 1 refinement)
- AI scoring: Spearman ρ ≥ 0.4 vs human, top-decile precision ≥ 0.7
- Bias: 4/5ths rule (selection rate ratio ≥ 0.8 between protected groups)
- Resume parser: ≥ 95% accuracy on curated 100-CV corpus
- Workday reconciliation: > 5 divergences in 7 days → P2 alert
- Bulk operations: P95 < 5s state transitions, < 30s message dispatch
- Mobile: P95 < 2s on 4G Mumbai/Bangalore baseline, ≤ 5 taps for core workflows
- Notification volume target: ~30/day per recruiter to avoid blindness
- Content scanner: precision ≥ 0.85, recall ≥ 0.7

---

## 4. What's NOT done — the honest list

### 4.1 Tier 3 requirements deferrals (from the Tier 1+2 pass)

These are real product gaps, intentionally deferred. Capture them in a future requirements update or in design system / Wave 1 build prompts:

- **Career-site mobile flow specification** — § missing concrete spec for the 320px viewport apply flow, file upload from camera roll, single-step vs multi-step, autosave, abandoned-application recovery
- **Active-employee post-hire experience** — Employee persona named in §3.3 but their HireOps interactions (Day 30 → resignation) not specified beyond document downloads
- **Re-hire workflow** — §8.3 says "rehire eligibility flag: yes/no/with-restrictions" but the actual rehire path (alumni applies → existing record found → flag respected) is undefined
- **Multi-tenant onboarding cross-reference in §1.5** — readers of `requirements.md` need a one-paragraph pointer to the tenant-onboarding workflow defined in `multi-tenancy-adr.md` §5.6
- **Candidate rejection workflow** — most common outcome, gets one mention but no spec for tone, timing, reapply rules, talent-pool consent prompt
- **Term consistency cleanup** — "AI scoring" vs "AI screening" used interchangeably; "bias shield" vs "fairness shield" vs "fairness check"; "WhatsApp" vs "WhatsApp Business"; capitalisation drift on "partner portal"
- **Smaller completeness edges** — fairness report consumers (HR Director? compliance? both?), SIEM language (already configurable but doc reads as "if Kyndryl wants"), exit-interview anonymisation tension (small-cohort exits hard to anonymise)
- **Untestable items deferred** — onboarding NPS targets, time-to-productivity targets per role, pre-joining ghosting threshold (require Kyndryl input)
- **§10.9 careers-site row** — note about future Kyndryl reskin if they later want `careers.kyndryl.com` to front

These can be batched into a "Tier 3 cleanup" prompt later if the user wants. Or they can be addressed individually as Wave 1 build hits the relevant areas.

### 4.2 Open structural items

- **`open-questions.md` gap #11** still PENDING — week-1 audit of Kyndryl's Workday Hire BP and Terminate BP step counts. If >2 approval steps, the 24h polling SLA in `workday-adr.md` §5.2 needs revisiting
- **8 Kyndryl POC-onboarding configuration items** — reframed as not platform-blocking, but Kyndryl needs to confirm/configure them during their tenant onboarding: GCC location (default India), Workday tenant access, SSO provider (Okta or Azure AD), BGV vendor (default AuthBridge), approval matrix, partner panel (3-5 friendly to start), MSA template, panel governance owner. Listed in `requirements.md` §12 with defaults documented.

### 4.3 Major work yet to be written

- **Design system spec** — was the user's original next-step ambition before the multi-tenancy rabbit hole. Now genuinely safe to write because the product is stable. Would cover: tokens, components, AI-component catalogue (AI-suggested-input, AI-score-with-explanation, AI-thinking, AI-error, AI-override), density grid (3 levels), data-table pattern, India-defaults (₹/IST/dd-mm-yyyy/Hindi-capable), WCAG 2.1 AA, multi-persona shared shell. Anchored to competitive-landscape benchmarks. Probably 700-1,000 lines.

- **Phasing analysis (Wave 1 execution plan)** — given the user's team is "Claude Code as the team" (not human engineers), what runs sequentially vs in parallel changes meaningfully. Sequential tracks: multi-tenancy structural prep (FND-15a/b/c) → schema → RLS → API → first vertical slice. Parallel-able: careers site, candidate portal flows (after API auth), internal portal pages, AI client setup, design system. Should be a structured doc at `/docs/internal/wave-1-execution-plan.md`. Written by Claude in chat, not Claude Code, because phasing is judgement.

- **Kyndryl admin spec** — deferred when partner-wireflows scope was narrowed to two surfaces. Covers Kyndryl-side panel dashboard, dispute resolution, partner detail tabs, audit views. Real work, but unblockable until design system is locked.

- **Workday field-mapping document** — explicitly deferred in workday-adr.md §7. Exhaustive list of every Workday field HireOps reads/writes and where it lives in HireOps schema. Engineering will need this before week 3 of any actual build.

- **Tenant-onboarding wizard spec** — the multi-tenancy ADR specifies the 8-step flow but doesn't draw the screens. Comparable in scope to `partner-wireflows.md`. Probably needed before the design system can address tenant admin surfaces.

### 4.4 Build hasn't started

The repo has the scaffold and the design docs. **No product code exists.** No database migrations have been run. No tests have been written. No CI is configured beyond the lint/typecheck/build basics. Every "Wave 1" task in `wave-1-backlog.md` is in the not-started state.

> Caveat: §4.5 below is the only exception — the FND-15a/b/c foundations have shipped, ahead of the rest of Wave 1. Everything outside the FND-15 series is still in the not-started state.

### 4.5 Foundations progress (FND-15 series)

- **FND-15a — DONE** (commits `8e87ba8`, `156d8c7`, `c1b7f6e`)
  Drizzle ORM + dual Supabase connections (transaction pooler for runtime, session pooler for migrations). `tenants` + `tenant_encryption_keys` tables. Migration 0000.
- **FND-15b — DONE** (commits `156d8c7`, `647a478`, `e854737`)
  `current_tenant_id()` + `has_role()` SECURITY DEFINER helpers. `custom_access_token_hook` injects `tid` / `tenant_slug` / `roles` JWT claims at sign-in. `tenant_user_memberships` join table. Verified end-to-end via `pnpm db:test:verify`.
- **FND-15c — DONE** (commits `76fe10c`, `16e72d2`, plus the chore commit at the tip of `feat/fnd-15c-rls-baseline`)
  RLS baseline + framework + lint script. Migration `0003_rls_baseline.sql` enables RLS + FORCE on `tenants`, `tenant_user_memberships`, and `tenant_encryption_keys`, with bespoke self-select policies on the first two and default-deny (no policies, service_role-only) on the third per ADR-002 §5.5. `packages/db/src/verify-rls.ts` runs an end-to-end isolation test. `packages/db/src/lint-rls.ts` queries pg_catalog and fails if any new public-schema table lacks RLS+FORCE+`tenant_isolation`, unless allowlisted. `auth_admin_read` policies allow `supabase_auth_admin` to read tenants + memberships from inside the SECURITY INVOKER auth hook. Root-level `pnpm db:*` proxy scripts added. Tagalong fixes: `migrate.ts` error-string wording for session-mode pooler; `turbo.json` outputs override for `@hireops/db#build`. **Re-tagging note:** the original `wave-1-backlog.md` had FND-15c as tenant-context middleware; that work has been renumbered to FND-15e (see backlog) and this RLS-framework work — originally FND-15e — adopted the FND-15c tag.
- **FND-15d — DONE** (commits `dcbcd0a`, `84f1219`, plus the tests + handover commit at the tip of `feat/fnd-15d-envelope-encryption`)
  Envelope encryption. `packages/db/src/kms/` exports `KmsClient`, `LocalKmsClient` (AES-256-GCM keyed by `SUPABASE_KEK_SECRET`; kmsKeyId = `"local:v1"`), an `AwsKmsClient` stub that throws (real AWS integration is future work), and a `getKmsClient()` factory dispatched by `KMS_PROVIDER`. `packages/db/src/envelope.ts` exposes `generateDek` / `wrapDek` / `unwrapDek` / `encryptWithDek` / `decryptWithDek` — same `iv || authTag || ciphertext` layout used by the local KMS. New `public.integration_credentials` table (tenant-scoped, FORCE RLS, admin-only `tenant_isolation_admin_select` policy) holds the bytea envelope plus jsonb metadata; 13 integration types are gated by a CHECK constraint. `storeIntegrationCredential` / `getIntegrationCredential` in `packages/db/src/integration-credentials.ts` are the service-role API surface — never call from a request handler with user-supplied tenantId. `pnpm db:provision:dev-dek` is the one-shot idempotent script that upgraded the kyndryl-poc tenant's placeholder DEK to a real wrapped one. DEK caching, KEK rotation flow, and the real AwsKmsClient are deferred. `pnpm db:lint:rls` now reports 14 tables (4 platform + 10 tenant-scoped). `apps/api/test/tenant-context.test.ts` extends to 17 cases — test 15 covers store/retrieve round-trip, test 16 proves cross-tenant decryption fails at the AES-GCM auth tag, test 17 verifies idempotent re-provision.
- **FND-15e — DONE** (commits `2003e9d`, `dce78f4`, plus the tests + handover commit at the tip of `feat/fnd-15e-tenant-context`)
  Tenant-context middleware (HTTP path) + `withTenantContext` helper (worker/script path). `packages/db/src/with-tenant-context.ts` wraps `db.transaction()`, sets `request.jwt.claims` via `set_config(..., is_local=true)`, and `SET LOCAL ROLE authenticated` so the policies in `0003_rls_baseline.sql` actually fire (the pool's underlying role bypasses RLS otherwise). `apps/api` scaffolded with Hono + `@hono/node-server`; JWT verification via `jose.createRemoteJWKSet` against the project's `/.well-known/jwks.json` (Supabase moved access tokens to ES256/asymmetric — `SUPABASE_JWT_SECRET` is no longer used for verification). Test endpoints `/test/whoami` + `/test/tenants` exercised by `pnpm api:test`, which covers no-JWT/bad-JWT/valid-JWT/RLS-scoping/worker-parity in one run. Subdomain extraction is not in scope here — that lives in the Next.js apps and is deferred to whichever frontend prompt wires it up.
- **FND-15f — NOT STARTED.** Tenant onboarding workflow MVP. Depends on 15c, 15d, 15e, plus INT-01.
- **DB-01 — DONE** (commits `3540d73`, `ca2ab4e`, plus the tests + handover commit at the tip of `feat/db-01-identity-schema`)
  Identity layer. Migration `0004_db01_identity.sql` (hand-written; Drizzle generate is blocked by pre-existing 0001/0002 snapshot drift) adds the `tenant_role` enum with the 11 platform roles, `public.users` (platform-level profile, FK to `auth.users`, user-scoped RLS), `public.business_units` (tenant-scoped, hierarchical via self-FK, `(tenant_id, slug)` unique), and extends `tenant_user_memberships` with `job_title` / `manager_id` (self-FK) / `business_unit_id` / `joined_tenant_at`. The roles column is migrated from `text[]` to `tenant_role[]` with a pre-check that fails the migration if any existing value sits outside the enum. RLS policies follow the framework: `users_self_select` + `users_self_update` + `users_auth_admin_read`; `tenant_isolation` on `business_units`. `pnpm db:lint:rls` now reports 5 tables, 4 platform (incl. `users`), 1 tenant-scoped. `apps/api/test/tenant-context.test.ts` extends to 7 cases covering user-scoped + tenant-scoped RLS. `verify-rls.ts` and `setup-test-user.ts` updated with explicit `::tenant_role[]` casts.
- **DB-02a — DONE** (commits `318852b`, `dbb9ec3`, plus the tests + handover commit at the tip of `feat/db-02a-positions`)
  Position foundation. Adds the `location_type` enum (`remote` / `hybrid` / `onsite` / `multi`) and four tenant-scoped tables: `headcount_envelopes` (approved budget per (business_unit, period), unique scope), `positions` (Workday-mirrored role slot, comp on the position not on JDs, partial unique index for active titles), `jd_versions` (versioned JD content per position, cascades from position), and `jd_skills` (skill + weight per JD version, cascades from jd_version). Migration is `0005_tranquil_scream.sql` (Drizzle-generated) + `0006_db02a_force_rls.sql` (hand-written companion adding FORCE RLS — Drizzle's pgPolicy + .enableRLS() emit ENABLE only). `pnpm db:lint:rls` now reports 9 tables, 4 platform, 5 tenant-scoped, all forced. `apps/api/test/tenant-context.test.ts` extends to 10 cases: test 9 covers positions tenant isolation, test 10 covers Drizzle round-trip through position → jd_version → jd_skills with the cascade chain.
- **DB-TENANT-FK — DONE** (commits `ab16fb4`, `178f844`, plus the tests + handover commit at the tip of `refactor/db-tenant-fk`)
  Cross-tenant FK protection at the DB level. Every cross-table FK between domain tables now references the target's compound `(tenant_id, id)` instead of just `id`. Each of the 10 domain tables gained a `UNIQUE (tenant_id, id)` constraint as a precondition; all 24 cross-table FKs were swapped from Drizzle's inline `.references()` to the extras-callback `foreignKey()` form with `[tenantId, <child_col>]` referencing `[target.tenantId, target.id]`. New FK names follow the `fk_<src>_<purpose>` convention (well under Postgres's 63-char identifier limit). Migration `0009_last_the_hand.sql` was Drizzle-generated then hand-reordered — Drizzle emits compound-FK ADDs before the UNIQUE ADDs they depend on, which would fail at apply. Test 14 in `apps/api/test/tenant-context.test.ts` is the smoking gun: it sets up a synthetic tenant + BU, attempts to insert a position into the test tenant pointing at the synthetic BU, and asserts the insert throws a FK violation. Test 11 also surfaced as a casualty of this work — it had been reusing the test user's membership for synth-tenant reqs (semantically wrong but undetected before this refactor); now creates a proper second membership in the synth tenant.
- **FND-OPS — DONE** (commit `<hash>` at the tip of `fnd-ops`)
  Phase 1 ops bedrock. New `packages/observability` exports `createLogger()` (pino with pino-pretty in dev, JSON in prod / test) and `getSentryClient(log)` which returns `RealSentryClient` (wraps `@sentry/node`, lazy-loaded via `createRequire` so the dep only resolves when `SENTRY_DSN` is set) or `LocalSentryClient` (logs every `captureException` / `captureMessage` through pino so dev mode stays useful without a Sentry account; breadcrumbs accumulate in a 50-entry ring buffer). `apps/api/src/lib/observability.ts` is the process-singleton. `tenantContext` middleware now generates `request_id` once (single source of truth: pino child logger, Sentry tag, `app.request_id` audit session var, `x-request-id` response header) and exposes `c.var.log` + `c.var.requestId`; per-request `sentry.setUser({ id: userId })` and `sentry.setTag('tenant_id', ...)` clear in finally. New `app.onError` handler captures uncaught exceptions to Sentry with request context + returns a 500 carrying the `request_id`. `console.log` in `apps/api/src/index.ts` replaced; the script call sites in `packages/db/src/{migrate,verify-rls,...}.ts` are out of scope per the prompt fence and remain. `.github/workflows/ci.yml` runs typecheck / lint / format / build in parallel and `api:test` / `db:lint:rls` serialised under `concurrency: { group: ci-db, cancel-in-progress: false }` so two pushes don't collide on shared dev-DB fixtures. `CONTRIBUTING.md` stub added with prerequisites + commands + CI overview + secret rotation note. `.env.example` gained `LOG_LEVEL` / `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` (all optional).
- **DB-02b — DONE** (commits `2a66923`, `6a5ea90`, plus the tests + handover commit at the tip of `feat/db-02b-requisitions`)
  Requisition layer. Adds the `knockout_type` enum (`boolean` / `numeric_min` / `numeric_max` / `enum`) and four tenant-scoped tables: `requisitions` (active hiring opening — FK chain to position+jd_version with RESTRICT so JD edits never affect live reqs; partial unique index on public_slug; status CHECK over 8 state-machine values), `requisition_recruiters` (sparse multi-recruiter junction), `requisition_knockouts` (typed knockout questions with jsonb threshold_value; source CHECK over parsed_cv/candidate_asserted/partner_asserted; ordered via order_index), and `requisition_state_transitions` (append-only audit with split RLS policies — `tenant_isolation_select` + `tenant_isolation_insert` only, no UPDATE/DELETE policies under FORCE RLS). Migration is `0007_living_tempest.sql` (Drizzle-generated) + `0008_db02b_force_rls.sql` (hand-written FORCE RLS companion). `pnpm db:lint:rls` now reports 13 tables, 4 platform, 9 tenant-scoped. `apps/api/test/tenant-context.test.ts` extends to 13 cases — test 11 covers requisition tenant isolation across a full BU → position → JD → req chain, test 12 verifies the append-only contract (INSERT/SELECT succeed, UPDATE/DELETE affect 0 rows), test 13 round-trips three knockouts with different types and jsonb thresholds. `packages/db/src/lint-rls.ts` was relaxed to accept either a single `tenant_isolation` policy or a set of `tenant_isolation_*` policies that together cover the table, each referencing `current_tenant_id()`.
- **AI-01 — DONE** (branch `ai-01-ai-client`)
  AI client abstraction. New workspace package `packages/ai-client` exporting `AIClient` interface + three implementations: `AnthropicAIClient` (default model `claude-sonnet-4-6`, structured output via forced tool-use), `OpenAIAIClient` (default model `gpt-5`, structured output via `response_format: json_schema { strict: true }`), and `LocalAIClient` (fixture-based by sha256 hash of `prompt + system + model + schema`). Vendor SDKs (`@anthropic-ai/sdk`, `openai`) are optional peer deps lazy-loaded via `createRequire` — same pattern as `RealSentryClient`. Async factory `getAIClient(tenant_id)` reads `tenants.settings.ai_provider` (default `'anthropic'`), resolves the per-tenant credential through `getIntegrationCredential` for `'ai_anthropic'` / `'ai_openai'` integration types, and caches per `(tenant_id, provider)` for 5 minutes. `NODE_ENV=test` or `AI_CLIENT_MODE=local` short-circuits to `LocalAIClient` so CI never burns real tokens. New `ai_usage_logs` table (migration `0018_complex_squirrel_girl.sql` + hand-written `0019_ai_usage_logs_force_rls.sql`) is append-only (split `tenant_isolation_select` + `tenant_isolation_insert` policies, no UPDATE/DELETE for authenticated), tracks `provider` / `model` / `feature` / token counts / `cost_micros` (bigint, 1 USD = 1,000,000 micros) / `latency_ms` / `succeeded` / `error_code`, indexed for per-tenant cost timelines and per-feature/per-model breakdowns. No audit trigger attached — `ai_usage_logs` IS the log, auditing inserts is noise (same exclusion as state-transition tables and approval_decisions). `integration_credentials_type_check` CHECK constraint extended to include `'ai_anthropic'` and `'ai_openai'`. Cost computation lives in `packages/ai-client/src/pricing.ts` as a per-model micros-per-token table; unknown models fall back to a per-provider default with a `console.warn`. `apps/api/test/ai-client.test.ts` adds 10 cases covering: fixture return, missing-fixture error message, structured JSON round-trip, usage-log success row, usage-log failure row (succeeded=false + error_code), cross-tenant RLS isolation, default-to-anthropic resolution + unsupported-value rejection, missing-credential factory throw, 5-min cache identity, AI_CLIENT_MODE=local env override. `pnpm db:lint:rls` now reports 15 tables, 4 platform, 11 tenant-scoped. Total `pnpm api:test` cases: 55 (45 → +10).
- **AI-02 — DONE** (commit `fac61b2`)
  Resume parser. Two-stage pipeline behind AI-01's `getAIClient`: extract (pdf-parse for text-layer PDFs, mammoth for DOCX, tesseract.js OCR fallback when text-layer < 100 chars; OCR is injectable so tests don't load the WASM) → structure (LLM via `completeStructured` against `parserOutputJsonSchema`, the JSON schema generated from the same Zod source). Canonical `ParserOutput` shape (personal / summary / total_years_experience / current_role / work_history / education / skills / notice_period_days / expected_compensation / parse_metadata) stored in `candidates.parsed_skills` jsonb. Conventions baked into the schema: ISO 8601 dates (`YYYY-MM` or `YYYY`), `current_role` mirrors `work_history[0]` when end_date is null, `total_years_experience` parser-reconciled against any explicit "X years" claim, `confidence_score` honest LLM self-report (apply form re-prompts at 0, recruiter UI flags below 0.7), `parser_version` semver bumped per schema change for re-parse decisions. Three failure modes graceful: unsupported mime / empty text / invalid LLM JSON each return low-confidence empty `ParserOutput` (no throw). 7 seed CV variants committed under `packages/ai-client/test/fixtures/resumes/`; real-Anthropic smoke produced LocalAIClient fixtures under `src/local/fixtures/` (sha256-keyed, prettierignored). All 7 hit the Phase-2 quality bar (non-null name/email/phone/YoE, valid JSON, confidence 0.62-0.72 — reflecting real text-extraction limits, especially mammoth on table-heavy DOCX). `apps/api/test/resume-parser.test.ts` adds 10 cases; tests via LocalAIClient with synthetic fixtures, no real API in CI. Total `pnpm api:test` cases: 65 (55 → +10). Schema documented in `docs/parser-output-schema.md`.
- **API-01 — DONE** (branch `api-01-trpc-skeleton`)
  Hono + tRPC skeleton with first six procedures. New workspace `packages/api-types` exports Zod input/output schemas + the `ApplicationStage` / `ApplicationSource` enums; frontend will import these. tRPC mounted at `/trpc/*` on the existing Hono app behind a new `optionalAuth` middleware (tries JWT, doesn't 401 — `publicProcedure` runs regardless; `protectedProcedure` throws `UNAUTHORIZED` itself + opens its own `withTenantContext` tx for ctx.db). tRPC's error formatter surfaces Zod failures as `BAD_REQUEST` with a flattened `zodError.fieldErrors` payload. Six procedures span the apply flow end-to-end: `submitApplication` (public mutation, audited — looks up requisition for tenant, fetches resume from storage, runs parseResume, dedups person by normalised email, idempotent on candidate + application creation); `getCandidateById` (protected query, audited); `listCandidates` / `getRequisitionById` / `listRequisitions` / `listApplications` (protected queries, cursor-paginated, no audit — DB-AUDIT already captures row reads at the trigger level). New pluggable Storage abstraction at `apps/api/src/lib/storage/` (`StorageClient` interface + `SupabaseStorageClient` + `LocalStorageClient` + `getStorageClient()` factory) — same three-tier pattern as KMS / Sentry / AIClient. `NODE_ENV=test` or `STORAGE_PROVIDER=local` short-circuits to in-memory storage so CI doesn't need the `candidate-uploads` Supabase bucket. `POST /api/upload/resume` accepts FormData with a 5MB cap, PDF/DOCX only, computes sha256 checksum, returns opaque `storageKey`. `GET /api/healthz` for process-level liveness (separate from FND-15e's `/health`; `/api/healthz` is the documented endpoint going forward). Audit-on-opt-in: new `api_audit_logs` table (migration `0020_hard_felicia_hardy.sql` + hand-written `0021_api_audit_logs_force_rls.sql`) records procedure-level INTENT (`submit_application`, `get_candidate_by_id`) — separate from `audit_logs` because `audit_logs.action` is `pgEnum('insert'|'update'|'delete')` and the ticket's reuse plan would fail at the enum constraint. Append-only (split policies, same as `audit_logs` itself), no audit trigger attached. `withAudit` helper is fire-and-forget — audit insert failure logs but never fails the user request; public procedures pass `tenantIdOverride` so the audit row gets the right tenant_id when ctx.tenantId is null. `apps/api/test/trpc-api.test.ts` adds 12 cases covering healthz, public-no-auth, protected-rejects, protected-accepts, Zod field errors, tenant isolation, withAudit firing, audit-failure-recoverable (compile-time guarantee), upload accept/reject/oversized, and an end-to-end upload→submit→DB chain using a real seed CV. Total `pnpm api:test` cases: 77 (65 → +12). `pnpm db:lint:rls` now reports 25 tables, 4 platform, 21 tenant-scoped.
- **DB-PARTNER-A — DONE** (branch `db-partner-a`)
  Partner identity + assignment + dedup schema — 8 tables, 5 enums. New enums (`partner_tier`, `partner_user_role`, `partner_assignment_status`, `ownership_claim_status`, `dedup_decision`). New tables: `partner_orgs` (empanelled vs ad-hoc), `partner_users` (separate identity from `public.users` — same auth.users source but never both in the same tenant), `partner_invitations` (sha256-hashed token-based onboarding), `partner_assignments` (which partners work which reqs, partial-unique on active rows), `candidate_ownership_claims` (6-month window, partial-unique on `(tenant_id, person_id) WHERE status = 'active'`, self-FK for the supersedes chain), `candidate_dedup_attempts` (append-only audit, split RLS), `partner_candidate_messages` (single tenant_isolation — deviated from append-only ticket lean since `delivery_status` is legitimately mutable), `ad_hoc_partner_domains` (email-intake routing, per-tenant partial-unique on `(tenant_id, domain) WHERE active = true`). Migrations: `0025_steep_lenny_balinger.sql` (Drizzle-generated) + hand-written `0026_db_partner_a_force_rls.sql` (FORCE RLS on 8) + `0027_db_partner_a_audit_triggers.sql` (audit_record_change on the 6 mutable tables; `candidate_dedup_attempts` and `partner_candidate_messages` excluded as log-shaped). `partner_users.user_id` references `auth.users(id)` without a Drizzle-modelled FK (same cross-schema pattern as `public.users`). `apps/api/test/db-partner-a.test.ts` adds 13 cases covering tenant isolation, compound-FK rejection, both partial-unique enforcements (assignments + claims), the `now()`-in-predicate deviation (see realities below), invitation hash lookup, audit trigger spot-checks, append-only enforcement on `candidate_dedup_attempts` (and the explicit non-append-only behaviour of `partner_candidate_messages`), `partner_users` per-tenant user_id uniqueness, ad-hoc-domain per-tenant uniqueness, the documented DB-level tier-mismatch acceptance, and the self-FK supersede chain. `pnpm db:lint:rls`: 33 tables, 4 platform, 29 tenant-scoped (was 25 → +8). Total `pnpm api:test` cases: 90 (77 → +13).
- **Module 1a — DONE** (branch `module-1a-portal-scaffold`)
  Internal portal scaffold + auth + read-only triage shell. Built apps/internal-portal as a Next.js 14 (App Router, React 18.3) workspace with Supabase Auth via `@supabase/ssr` (cookie-based session, middleware redirects unauthed traffic to /login), tRPC client wired via `@trpc/react-query` (httpBatchLink attaches Bearer token from the browser Supabase session), and a server-side caller `createServerTRPCCaller` that skips HTTP and inlines into the same process by handing a constructed `HonoTRPCContext` to `appRouter.createCaller`. Pages: `/` redirects to /triage or /login, `/login` (client form via `@hireops/ui` primitives), `/logout` (route handler), `/triage` server-renders the candidate list via `listCandidates`. Design tokens flow from `@hireops/ui/src/tokens.css` (imported in globals.css). DevBanner in the corner for non-production envs. RootErrorBoundary + per-route error.tsx + loading.tsx. ESLint `jsx-a11y` plugin added to the repo-root flat config (only fires on JSX). New `db:seed:test-users` script provisions `recruiter1@kyndryl-poc.test` / `hr_ops1@kyndryl-poc.test` / `admin1@kyndryl-poc.test` (password `TestPassword123!`, dev-only) idempotently. Turbo `dev` task + root `pnpm dev` orchestrate apps/api + apps/internal-portal in parallel. Storybook in the app for presentational pieces (LoginForm, TriageEmptyState — server-component pages aren't story-friendly). Vitest (8 unit tests: env validation + tRPC error handler mapping). Playwright at repo root with `@axe-core/playwright`; one golden-path E2E in `e2e/golden-path.spec.ts` (login → /triage → axe assertion). `apps/api` gets a small change: new `./trpc` export entry (`apps/api/src/trpc/index.ts`) so cross-workspace consumers can import `appRouter` without triggering the Hono `serve()` boot in `apps/api/src/index.ts`. CONTRIBUTING.md gains a "Local dev workflow" section. **Deviation:** Next.js 14.2 instead of "15+" — Next 15's React 19 default would collide with packages/ui's React 18.3 peer (duplicate React → broken hooks). Sticking with React 18.3 across the monorepo is the cheaper path; Next 14.2 has App Router and parity for everything we need today. Revisit when packages/ui upgrades to React 19. Total `pnpm api:test`: 90 (unchanged). Portal Vitest: 8 cases. Playwright: 1 case (E2E, run separately via `pnpm e2e`).

**Codebase realities introduced by FND-15c:**

1. **RLS framework via lint script.** `packages/db/src/lint-rls.ts` is the source of truth for which tables are tenant-scoped vs platform. Every new table added in a migration must either satisfy the tenant-isolation policy contract or be added to the `PLATFORM_TABLES_ALLOWLIST` set in that script with a justifying comment. Don't disable the lint; if it fails, fix the schema.
2. **Auth hook reads require `supabase_auth_admin` policies under FORCE RLS.** The Custom Access Token hook runs as `supabase_auth_admin`, which does NOT bypass RLS. Any table the hook reads (currently `tenants` and `tenant_user_memberships`) must have an explicit policy granting `supabase_auth_admin` SELECT — otherwise the hook silently returns no custom claims and the JWT goes out missing `tid`/`tenant_slug`/`roles`. Symptoms: JWT looks valid, sign-in succeeds, but `current_tenant_id()` returns null in RLS policies. Diagnosis: invoke the hook function directly via SQL — if direct invocation produces correct claims but sign-in JWT doesn't, you're hitting this. See migration `0003_rls_baseline.sql` for the policy pattern.
3. **`tenant_encryption_keys` is allowlisted and policy-less.** RLS+FORCE on, no policies → default-deny for `authenticated`. `service_role` (BYPASSRLS) is the only legitimate access path. Don't add an authenticated-role policy here — the DEK store must never be reachable via a user JWT.
4. **Migrations apply via session-mode pooler.** `DIRECT_URL` is `aws-N-<region>.pooler.supabase.com:5432` (dual-stack IPv4+IPv6). The error string in `migrate.ts:15` documents this. If you see "This must be the direct connection" anywhere, it's an outdated comment and needs updating.
5. **Supabase pause/resume can reset auth-hook dashboard registration.** Observed twice during FND-15c. Symptoms: SQL side intact, function works in direct invocation, but JWT has no custom claims after sign-in. Recovery: re-enable the hook via dashboard (Authentication → Hooks → Customize Access Token (JWT) Claims → toggle on, source Postgres, schema public, function `custom_access_token_hook`, save). Wait ~60s for propagation before retesting. The `diagnose-hook.ts` script isolates function correctness from dashboard registration — run it first to confirm you're chasing the right failure mode.

**Codebase realities introduced by FND-15e:**

6. **Request-scoped DB access requires `withTenantContext`.** Code that runs inside an HTTP request handler must use `c.var.db` (set by the `tenantContext` middleware), NOT the singleton `db` exported from `@hireops/db`. The singleton uses the unscoped pool and RLS returns zero rows because `request.jwt.claims` is unset and the connection runs as `postgres` (which bypasses RLS anyway). Code that runs outside request context (workers, scripts, migrations) uses `withTenantContext(claims, async ({ db }) => ...)` when it needs tenant scoping, or the raw singleton when it's an admin operation that intentionally bypasses RLS via service_role.
7. **`SET LOCAL ROLE authenticated` is part of the contract.** The connecting role on the pool (e.g. `postgres.<project-ref>`) bypasses RLS. `withTenantContext` switches the connection to `authenticated` inside the transaction so the policies — which target `TO authenticated` — actually apply. If a future migration adds a policy `TO service_role` or `TO some_other_role` for a tenant-scoped table, expect surprises until the helper's role switch is reconsidered.
8. **Supabase access tokens are ES256 / JWKS, not HS256.** Supabase migrated to asymmetric API keys. Verification is via `createRemoteJWKSet(new URL('<SUPABASE_URL>/auth/v1/.well-known/jwks.json'))`. The `SUPABASE_JWT_SECRET` env var is legacy and not consulted by `apps/api`. Any future verifier should follow the same pattern; do not reintroduce an HS256 path.

**Codebase realities introduced by DB-01:**

9. **Fixed role enum, no custom roles.** Wave 1 uses `public.tenant_role` with 11 fixed values (`admin`, `recruiter`, `hiring_manager`, `panel_member`, `hr_ops`, `people_ops`, `it_admin`, `partner_admin`, `partner_user`, `candidate`, `employee`). Custom tenant-defined roles are deferred to Wave 2+. The enum is defined in `0004_db01_identity.sql` and modelled in Drizzle at `packages/db/src/schema/roles.ts` via `pgEnum("tenant_role", TENANT_ROLES)`. The auth hook reads from `tenant_user_memberships.roles` (now `tenant_role[]`), so the JWT `roles` claim is implicitly constrained by the enum.
10. ~~**Drizzle still types `tenant_user_memberships.roles` as `text[]`.**~~ **Resolved by DRIZZLE-INFRA-01** (commits `1b22309`, plus the workaround-removal commit at the tip of `chore/drizzle-infra-cleanup`). The Drizzle schema now uses `tenantRoleEnum("roles").array()` and inserts via `db.insert(tenantUserMemberships).values({ roles: ["admin"] })` round-trip cleanly — verified by integration test 8 in `apps/api/test/tenant-context.test.ts`. The raw-SQL workaround in `setup-test-user.ts` has been reverted to a normal Drizzle insert.
11. ~~**Drizzle snapshot chain is broken from 0001/0002.**~~ **Resolved by DRIZZLE-INFRA-01** (commit `1b22309`). Snapshot ids/prevIds repaired, missing 0003/0004 snapshots seeded. `pnpm --filter @hireops/db db:generate` now runs cleanly and reports zero diffs against the current schema. The schema files model RLS / policies / pgEnum / FK names so future migrations can be Drizzle-generated. The two cross-schema auth.users FKs (`users_id_fkey`, `tenant_user_memberships_user_id_fkey`) still aren't modelled — they live in the migrations but not the Drizzle snapshot, which is intentional. The `.prettierignore` excludes `packages/db/drizzle/migrations/meta/` so drizzle-kit's own formatting survives `pnpm format`.
12. **`public.business_units` is the canonical intra-tenant org table.** Use `business_units` (not "departments" / "divisions" / "org_units"). A tenant whose internal terminology differs overrides the display label via tenant settings, not via renamed tables. Recruiters, requisitions, and partners will FK to `business_units.id` in later DB-* migrations.

**Codebase realities introduced by DB-TENANT-FK:**

13. **Compound `(tenant_id, id)` FKs across domain tables.** Every cross-table FK between domain tables references the compound `(tenant_id, id)` of the target, not just `id`. This prevents cross-tenant references at the DB level regardless of whether RLS is engaged (service_role paths, bulk imports). Every new domain table must add `unique("uniq_<table>_tenant_id_id").on(table.tenantId, table.id)` to its extras and use the `foreignKey()` extras-callback syntax for any cross-table FK. New FK constraints use the `fk_<src>_<purpose>` naming convention to stay well below Postgres's 63-char identifier limit. The `lint-rls.ts` framework doesn't enforce this yet — if it becomes worth automating, that's a follow-up.
14. **Drizzle emits compound FKs before the UNIQUE constraints they depend on.** Running `db:generate` for a compound-FK refactor produces a migration that Postgres will reject at apply because the ADD CONSTRAINT FOREIGN KEY referencing `(tenant_id, id)` requires a matching UNIQUE to exist first. Reorder the emitted SQL by hand: DROPs first, then UNIQUE ADDs, then FK ADDs. The snapshot still represents the end state correctly, so subsequent `db:generate` runs are clean. If a future Drizzle version fixes the emit order, this manual step becomes a no-op.

**Codebase realities introduced by FND-15d:**

15. **Envelope encryption via pluggable KMS.** Per-tenant DEKs (32-byte AES-256 keys) are stored wrapped in `tenant_encryption_keys.encrypted_dek`; the wrapping master KEK lives outside the DB. Local dev uses `LocalKmsClient` (AES-256-GCM keyed by `SUPABASE_KEK_SECRET` — 64 hex chars in `.env`, never committed). Production will use `AwsKmsClient` against a real KMS-managed master key — switch via `KMS_PROVIDER=aws` + `AWS_KMS_KEY_ARN`. The AWS stub currently throws; the real implementation lands with the ops tooling. Wire format for every envelope (wrapped DEKs and application payloads): `iv (12 bytes) || authTag (16 bytes) || ciphertext (N bytes)`. The high-level API — `storeIntegrationCredential` / `getIntegrationCredential` in `packages/db/src/integration-credentials.ts` — runs as service_role through the unscoped pool because `tenant_encryption_keys` has no `authenticated` policies. NEVER call those helpers from a request handler with user-supplied `tenantId` — validate against the request's authenticated context first.
16. **`integration_credentials.credential_envelope` should never be returned to authenticated callers.** Column-level grants don't compose cleanly with RLS under FORCE, so the policy permits admin SELECTs on the whole row and the app layer is responsible for projecting `metadata` only. Future code adding new integration types should extend the CHECK constraint on `integration_type` rather than introducing a pgEnum — the list grows in lockstep with marketplace integrations and ALTER TYPE is more painful than CHECK extension.

**Codebase realities introduced by FND-OPS:**

17. **Logger usage in `apps/api`: pino structured logging via `c.var.log`.** The tenant-context middleware binds a child logger with `request_id` / `tenant_id` / `actor_user_id` for every authenticated request; handlers should use that, not `console.*` or the base logger. Pino's idiom is `log.error({ err, ...context }, 'short message')` — context goes in the object, not a template string, because that's what makes `jq` queries useful at log-aggregation time. Outside request context (workers, scripts), import `createLogger` from `@hireops/observability` directly.
18. **Sentry: local-by-default, gated on `SENTRY_DSN`.** Same pattern as KMS (`getKmsClient` / `LocalKmsClient` / `AwsKmsClient`). `getSentryClient(log)` returns `RealSentryClient` when `SENTRY_DSN` is set, `LocalSentryClient` otherwise. `LocalSentryClient` logs every captured payload through pino so dev mode stays useful without a Sentry account. `RealSentryClient` lazy-loads `@sentry/node` via `createRequire` — the dep is an optional peer, only required when actually enabled. The `request_id` is the single source of truth across logger, Sentry tag, `app.request_id` session var (DB-AUDIT trigger), and the `x-request-id` response header — generated once in the tenant-context middleware.
19. **CI runs all gates on every push; DB jobs are serialised.** `.github/workflows/ci.yml` splits jobs: parallel for typecheck/lint/format/build (no DB), serialised for `api:test` + `db:lint:rls` via `concurrency: { group: ci-db, cancel-in-progress: false }`. The serialisation matters because both jobs hit the same dev Supabase and the test fixtures clean up by id — concurrent runs would collide the same way they did locally before FND-TEST. CI does not gate merges yet (no branch protection); that's a multi-engineer concern.

**Codebase realities introduced by AI-01:**

20. **AI provider routing: per-tenant via `tenants.settings.ai_provider`.** Free-text key inside the existing `tenants.settings` jsonb — values are `'anthropic'` (default if unset) or `'openai'`. No migration required to read or write it; `settings` is jsonb. Adding a third provider (Gemini, Bedrock) is a one-line literal addition in `packages/ai-client/src/types.ts` plus a new client class. The resolver in `packages/ai-client/src/factory.ts` deliberately throws on unsupported values rather than silently falling back — wrong cost attribution is worse than a loud error.
21. **AI credentials use the integration_credentials envelope-encryption pathway.** Two new `integration_type` values: `'ai_anthropic'` and `'ai_openai'`. Stored encrypted via `storeIntegrationCredential`; read via `getIntegrationCredential` from inside the service-role pool. The `integration_credentials_type_check` CHECK constraint was extended in migration `0018_complex_squirrel_girl.sql` — same pattern as adding any new integration type (CHECK extension, not pgEnum, because the list grows in lockstep with marketplace integrations). Reality 16 still applies: never return `credential_envelope` to authenticated callers.
22. **`ai_usage_logs` is append-only and not audited.** Two policies: `tenant_isolation_select` + `tenant_isolation_insert`, no UPDATE/DELETE for authenticated under FORCE RLS (same shape as `requisition_state_transitions` / `application_state_transitions` / `approval_decisions`). The `audit_record_change` trigger is intentionally NOT attached — the table IS the log; auditing every insert would create a 1:1 noise stream. Service-role rewrites (admin escape hatch) still bypass everything via `poolDb`. Cost is stored in integer `cost_micros` (bigint; 1 USD = 1,000,000 micros) to preserve precision below the cent — a 100-token Sonnet call costs ~300 micros = $0.0003, which would round to 0 in integer cents and destroy per-call signal. Display layer divides for cents or dollars.
23. **Optional peer SDKs for LLM providers: lazy-loaded via `createRequire`.** `@anthropic-ai/sdk` and `openai` are listed in `peerDependencies` with `peerDependenciesMeta.optional: true`. `AnthropicAIClient` / `OpenAIAIClient` call `loadSDK()` in the constructor (NOT at module top) and throw a clear `pnpm add …` message if the dep is missing. Same pattern as `RealSentryClient` + `@sentry/node`. Means importing `@hireops/ai-client` is free in dev/test when only `LocalAIClient` is exercised — no SDK install required for CI.
24. **`LocalAIClient` is fixture-based, keyed by sha256 of `prompt + system + model + schema`.** Fixtures live in `packages/ai-client/src/local/fixtures/<hash>.json` by default; tests override `fixtureDir` to ship inline. A missing fixture throws with the exact path that would have matched — tests fail loud rather than fall back to a "model returned something reasonable" behaviour. The fixture format includes simulated `inputTokens` / `outputTokens` / `costMicros` so the cost-logging path is exercised end-to-end in tests; the optional `throw: { message, code }` field lets a fixture simulate a provider error and verify the `succeeded=false` + `error_code` log row. Hash helpers (`hashCompleteOptions` / `hashStructuredOptions`) are exported so test authors can compute fixture paths programmatically.
25. **Real-provider verification via a temporary smoke script, deleted before commit.** `packages/ai-client/scripts/smoke.ts` provisions a test credential, calls `complete()` + `completeStructured()` against each configured provider with a small Haiku/nano model, asserts `ai_usage_logs` rows have non-zero tokens + cost, cleans up. Run with `ANTHROPIC_API_KEY=… OPENAI_API_KEY=… pnpm exec tsx packages/ai-client/scripts/smoke.ts`. **Delete the script before commit** — same pattern as the FND-OPS smoke check. Recreating it when needed is faster than maintaining it as committed code with secrets handling, and CI is covered by the LocalAIClient tests.

**Codebase realities introduced by AI-02:**

26. **`candidates.parsed_skills` schema is locked by `parserOutputSchema`.** Every downstream consumer — recruiter detail page, AI scoring, knockout evaluation, partner submission — depends on this shape. Documented in `docs/parser-output-schema.md` with conventions: `current_role` mirrors `work_history[0]` when its end_date is null, `total_years_experience` is parser-reconciled (the LLM hands per-job spans, the parser sums + reconciles against any explicit "X years" claim), `grade` is free text (Indian CGPA/percentage/division/class wildly varies and normalising loses info), dates are ISO 8601 `YYYY-MM` or `YYYY`. Bump `PARSER_VERSION` (semver, in `packages/ai-client/src/parsers/resume-schema.ts`) on every schema change; downstream re-parse logic reads `parse_metadata.parser_version` to decide.
27. **The parser never throws; three failure modes are graceful.** Unsupported mime type / empty extracted text / LLM error all return a low-confidence empty `ParserOutput` (`confidence_score = 0`, all PII fields null, `source_format = 'unknown'` for the mime case). The apply form re-prompts at 0; the recruiter detail page flags "review carefully" below 0.7. This is deliberate — `submitApplication` must accept the upload and let a human triage data quality, not 500 because the LLM had a bad day.
28. **`tesseract.js` postinstall is explicitly DENIED in `pnpm-workspace.yaml`.** The postinstall is `opencollective-postinstall || true` (donation banner) — runtime OCR works without it. The allowBuilds entry `tesseract.js: false` silences pnpm's ignored-builds warning without granting the script. If any future dep needs an actual postinstall, evaluate it deliberately and document in the same allowBuilds block.
29. **`LocalAIClient` fixtures are prettier-ignored.** `packages/ai-client/src/local/fixtures/` is in `.prettierignore` — fixture JSON is sha256-keyed by the content the LLM saw, so reformatting changes nothing useful but can churn the canonical bytes consumers diff against. Smoke runs regenerate fixtures; tests read them byte-stable.

**Codebase realities introduced by API-01:**

30. **tRPC is mounted at `/trpc/*` behind `optionalAuth`, not `tenantContext`.** The strict `tenantContext` middleware (FND-15e) still gates `/test/*` and opens the per-request `withTenantContext` tx itself. The new `optionalAuth` middleware (`apps/api/src/middleware/optional-auth.ts`) attempts JWT verification but does not 401 on failure — it sets `c.var.{tenantId,userId,claims}` to null and lets tRPC decide. `publicProcedure` runs regardless; `protectedProcedure` throws `UNAUTHORIZED` and then opens a per-call `withTenantContext` tx (so each protected procedure has its own RLS-scoped `ctx.db`, isolated from sibling procedures in a batched tRPC request).
31. **Procedure naming + router shape: flat, verb-first.** `appRouter` in `apps/api/src/trpc/router.ts` is a single flat tRPC router. Naming follows `listX` / `getXById` / `submitY`. Re-evaluate at ~50 procedures; for Phase 2's ~30 the flat shape is right. Frontend imports `import type { AppRouter } from '@hireops/api/trpc/router'` (type-only, erased at bundle time) plus runtime Zod schemas from `@hireops/api-types`. The two-package split keeps the implementation out of the frontend bundle while sharing the validation contract.
32. **Audit-on-opt-in policy via the `withAudit` helper.** State changes and PII reads opt in (`submitApplication`, `getCandidateById`); routine browses do not (`listCandidates`, `listRequisitions`, `listApplications`). DB-AUDIT trigger already captures row changes; `api_audit_logs` captures the API action that DROVE the change — the question regulators ask. The helper is fire-and-forget: audit insert failure logs and returns the user response anyway. Public procedures (no `ctx.tenantId`) pass `tenantIdOverride` so the audit row gets the right tenant. Convention for the `action` value: snake_case of the procedure name.
33. **`api_audit_logs` is a separate table from `audit_logs`.** Deliberate split: `audit_logs.action` is `pgEnum('insert'|'update'|'delete')` (DML verbs only), and the API actions (`submit_application`, `get_candidate_by_id`) don't fit. Extending the enum would conflate two audit purposes and bias every future query. `api_audit_logs` is append-only (split RLS policies, no UPDATE/DELETE for authenticated under FORCE RLS), no audit trigger attached — it IS the log. Not partitioned in Wave 1 (~300 candidates/month → ~10k API calls/month doesn't justify it); re-evaluate when volume calls for it.
34. **Pluggable object storage at `apps/api/src/lib/storage/`.** Same three-tier pattern as KMS / Sentry / AIClient. `SupabaseStorageClient` uses the service-role key so the API holds the only credential that can write the `candidate-uploads` bucket; the apply form hits the API, never Supabase Storage directly. `LocalStorageClient` is an in-memory Map for tests + dev. `getStorageClient()` factory picks via `NODE_ENV=test` (force local) → `STORAGE_PROVIDER=local` (dev convenience) → Supabase (requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). The `candidate-uploads` bucket itself lives outside Drizzle — provision per-Supabase-project via the dashboard or CLI; steps documented in `CONTRIBUTING.md`.
35. **`POST /api/upload/resume` is public.** Apply form runs pre-login; this endpoint accepts FormData with a 5MB cap and PDF/DOCX only, returns an opaque `storageKey`. Possessing the key doesn't grant access to anyone else's data — Storage policies on `candidate-uploads` allow only authenticated SELECT (and we proxy reads through the API), and writes are service-role-only. Image-only/vision-to-JSON is deferred — the parser already handles scanned PDFs via OCR if/when one comes through this endpoint.
36. **Zod errors surface as field-level data via the tRPC error formatter.** `apps/api/src/trpc/trpc-core.ts` adds `data.zodError = error.cause.flatten()` for `BAD_REQUEST` errors whose cause is a `ZodError`. Frontend reads `err.data.zodError.fieldErrors[fieldName]` to render per-field messages. Non-Zod errors flow through tRPC's default formatter unchanged.
37. **`HonoTRPCContext` typing — adapter requires a cast.** `@hono/trpc-server`'s `createContext` is typed as returning `Record<string, unknown>`, but our shaped `HonoTRPCContext` carries specific types. We return the shaped object and cast `as unknown as Record<string, unknown>` at the adapter boundary; the typed view downstream comes from `initTRPC.context<HonoTRPCContext>()`. If `@hono/trpc-server` ships a generic over the context shape later, drop the cast.

**Codebase realities introduced by DB-PARTNER-A:**

38. **Partner identity is parallel to internal identity, NEVER both.** `partner_users` and `tenant_user_memberships` both reference `auth.users(id)`, but a given `auth.users.id` MUST exist in at most one of them per tenant. The "internal OR partner, never both" rule isn't expressible as a single CHECK across two tables in standard Postgres without a trigger. App-layer enforcement at user-provisioning time + a periodic audit query is the live discipline. The audit query (runs as part of housekeeping): `SELECT user_id FROM partner_users pu JOIN tenant_user_memberships tum USING (tenant_id, user_id);` — any rows returned are violations. A human can be partner in tenant A and internal in tenant B independently; the rule is per-tenant.
39. **Invitation token discipline: hash before storing.** `partner_invitations.token_hash` is SHA-256 hex of the raw token. Generate 32 bytes via `randomBytes(32)`, base64url-encode (~43 chars) — that's what goes in the email link. Never log the raw token, never store it. Validation: `createHash('sha256').update(incomingToken).digest('hex')` → compare to stored hash. Same shape as how passwords are stored. The partial-unique on `(tenant_id, token_hash) WHERE consumed_at IS NULL AND revoked_at IS NULL` enforces no two live tokens share a hash within a tenant.
40. **`now()` is not allowed in partial-index predicates** — Postgres requires IMMUTABLE functions. Two indexes the ticket proposed using `expires_at > now()` had to drop that clause: `partner_invitations.uniq_partner_invitations_live_token` (predicate is now just `consumed_at IS NULL AND revoked_at IS NULL`) and `candidate_ownership_claims.uniq_active_claim_per_person` (predicate is now just `status = 'active'`). For ownership claims this makes the **background expiry sweep load-bearing** — a row with `status='active' AND expires_at < now()` will block a new claim until the sweep flips status to `'expired'`. Daily sweep is enough for a 6-month window; the test in `apps/api/test/db-partner-a.test.ts` documents this behaviour explicitly so future readers don't think the index does the time check.
41. **`partner_candidate_messages` is mutable (single tenant_isolation), not append-only.** The ticket leaned this way as an option; we took it. `delivery_status` is legitimate mutable state (pending → sent → delivered/failed). Row content (subject/body/sent_at) is immutable by convention — no UI path mutates it. No audit trigger attached because the table is conceptually a message log, same exclusion as `candidate_dedup_attempts` and `ai_usage_logs`.
42. **`ad_hoc_partner_domains.partner_org_id` SHOULD reference a partner_org with `tier='ad_hoc'`, but the DB does not enforce it.** Cross-table CHECK isn't expressible in standard SQL; the constraint lives in the application layer (the admin form that creates a domain must validate). The test `apps/api/test/db-partner-a.test.ts:Test 11` asserts that the DB *accepts* an empanelled-tier link, documenting the gap so future code doesn't assume the DB has its back.
43. **Drizzle journal renumbering for hand-written companions.** When a Drizzle-generated migration follows hand-written ones in the journal but needs to apply BEFORE them (e.g. tables it creates that the hand-written ones reference), reorder the journal entries — Drizzle applies in journal-array order, not lexical filename order. For DB-PARTNER-A the hand-written FORCE RLS + audit triggers had been pre-staged as 0023/0024; the regenerated table-creation migration was named 0025 so the hand-written files were renamed to 0026/0027 with matching journal entries in apply order (25 → 26 → 27).

**Codebase realities introduced by Module 1a:**

44. **React version is pinned to 18.3 across the monorepo, not 19.** `packages/ui` peer-depends on React 18.3.1; mixing in React 19 anywhere (e.g. via Next 15) would yield duplicate React copies in the bundle and "Invalid hook call" runtime errors. apps/internal-portal stays on Next.js 14.2 (App Router, React 18). When `packages/ui` ships its React 19 upgrade, Next 15+ becomes safe everywhere.
45. **Server-component data fetching uses an in-process tRPC caller, not HTTP.** `apps/internal-portal/src/lib/trpc-server.ts` builds a `HonoTRPCContext` directly from the Supabase session and passes it to `appRouter.createCaller`. No HTTP hop, no JSON round-trip — server components call procedures as plain async functions. For protected procedures the per-call `withTenantContext` middleware inside `apps/api/src/trpc/trpc-core.ts` still opens its own tx, so RLS scoping is intact; `ctx.db` is left undefined in the caller-side context (the middleware overrides it).
46. **Side-effect-free entry: `import from "@hireops/api/trpc"`, NOT `"@hireops/api"`.** apps/api's root `src/index.ts` boots a Hono `serve()` listener under any non-test `NODE_ENV`. Importing that from a Next.js server component would attempt to listen on port 3001 inside the Next process. The `./trpc` subpath export added in API-01-to-Module-1a points at `src/trpc/index.ts`, which just re-exports `appRouter` + types — no side effects.
47. **`.env` → `NEXT_PUBLIC_*` mirroring lives in `next.config.mjs`.** Supabase URL + anon key are inherently public (the anon key is designed for client use). The workspace `.env` only stores `SUPABASE_URL` / `SUPABASE_ANON_KEY`; the Next config (a) loads the workspace `.env` via dotenv at config evaluation time so cross-workspace modules (`@hireops/db`'s `DATABASE_URL` check, etc.) see it, and (b) mirrors `SUPABASE_*` → `NEXT_PUBLIC_SUPABASE_*` so client-bundled code can read them. Skip the mirror in production by setting `NEXT_PUBLIC_*` directly in the deploy env.
48. **`next.config` must be `.mjs` on Next 14** — TS configs land in 15+. We use `.mjs` with JSDoc `@type {import('next').NextConfig}` for editor IntelliSense; tsc on the workspace excludes config files via the repo-root eslint ignore pattern, so this is purely a runtime choice with no TS friction.
49. **Login + triage are both `dynamic = "force-dynamic"`.** `/login` reads `useSearchParams()` (for the `?from=` redirect target) and `/triage` reads cookies (for the session). Either of those bumps Next out of static generation; explicit force-dynamic surfaces that decision in the page file rather than letting a future code reviewer guess why builds suddenly started failing.
50. **`jsx-a11y` lint plugin in the repo-root flat config, scoped to `.{jsx,tsx}`.** Single source of truth across every React-touching workspace; no per-app duplication. Radix primitives already supply ARIA semantics for the standard widgets, so the lint mostly catches the regressions: missing `alt`, label-control mismatches, role on the wrong element.
51. **Playwright config + E2E live at the REPO ROOT, not nested in any app.** `e2e/` directory + `playwright.config.ts` cover any test that spans multiple apps + the API + the DB. The config boots `pnpm dev` via the `webServer` block (180s timeout); set `E2E_NO_WEBSERVER=1` to use an externally-started dev server (CI pattern). The golden-path test asserts axe-core finds zero violations on `/triage`.
52. **Test users live in `packages/db/src/scripts/seed-test-users.ts`** — idempotent. Password is `TestPassword123!` for all three personas (recruiter / hr_ops / admin) in the `kyndryl-poc` tenant. Dev-only — the password is meant to be guessable so the E2E test can hardcode it; production user provisioning is a separate ticket. Run `pnpm db:seed:test-users` once per new dev DB.

---

## 5. How the user works

This matters as much as the technical state. Get this wrong and the conversation dynamic breaks.

### 5.1 Communication style

- **Terse, decisive.** The user types in lowercase, often skips punctuation, sometimes truncates words. This is fine — it's how they communicate, not a sign of inattention. Don't read it as low-engagement.
- **Trusts recommendations over menus.** When asked "do you want to compare options or recommend one?", they reliably say "recommend." For ADR-style decisions (Workday integration, multi-tenancy), they explicitly accepted "recommend and justify rather than menu of options" as the working pattern.
- **Skips picker questions when they want you to just go.** Don't get stuck waiting on a picker that returned nothing — proceed with reasonable defaults and tell them what you assumed. They'll override if they disagree.
- **Pushes back when something's wrong.** When they reframed HireOps from "Kyndryl-customer build" to "multi-tenant SaaS product," that was a major correction that should have been caught earlier. Take their pushback seriously when it comes.

### 5.2 The working rhythm

The pattern that's worked across this project:

1. **User describes what they want next** (often briefly)
2. **Claude in chat thinks through it before responding** — explicitly weighs trade-offs, flags assumptions, asks clarifying questions where they actually matter (not for everything)
3. **Claude writes a Claude Code prompt** with explicit scope fences, verification gates, and prescriptive language for high-risk edits
4. **User pastes prompt into Claude Code** at their terminal in `~/Desktop/workspace/hireops`
5. **Claude Code does the work**, prints a summary
6. **User pastes the summary back** into chat
7. **Claude in chat verifies the output**, suggests next prompt or pivot

**Important nuance:** the user does the actual Claude Code execution. Don't try to do it in this chat — there's no terminal access here. Write the prompt, the user pastes.

### 5.3 What Claude has been doing well

These behaviours work and should continue:

- **Pushing back proactively** when about to make a wrong call. Examples: "Let me think about whether this is actually a good idea before just doing it" before going straight to design system; flagging that the requirements pass should come before phasing; pointing out that the .docx file rename didn't actually convert the format.
- **Researching with web_search before claiming current facts.** Workday API versions, Supabase RLS patterns, multi-tenant SaaS conventions — verified rather than assumed. The user trusts research-grounded claims more than memory-based ones.
- **Writing Claude Code prompts with explicit scope fences.** Every prompt has "you will / you will not" sections, verification commands, and explicit "stop and ask" instructions for ambiguous cases. Without these, Claude Code drifts.
- **Flagging proactively when something looks off.** The competitive-landscape.docx detection. The "0 insertions" git commit warning. These are easy to miss but matter.
- **Recommending defaults and explaining the reasoning.** Not "here are 5 options," but "I recommend X for these reasons; here's the alternative if you disagree."
- **Being honest about uncertainty.** "I'd be more worried if it came in at exactly 700 lines because that would suggest Claude Code optimised for the target." Honest assessments build trust.

### 5.4 What Claude has been doing wrong (and should avoid)

Things that have happened in this conversation that were corrections after the fact:

- **Initially framing HireOps as a Kyndryl-customer build instead of a SaaS product.** Should have asked the multi-tenancy / business-model question much earlier. When in doubt about product positioning, ask.
- **Assuming the user wanted three surfaces in the partner-wireflows doc** when they explicitly said two. Read what's asked, not what seems comprehensive.
- **Producing competitive-landscape content as inline chat instead of a proper file** when file tools dropped — should have flagged the fallback rather than letting the user end up with a Word doc renamed to `.md`.

Pattern to avoid: scope creep masked as helpfulness. If the user asks for X, do X. If you think Y also matters, flag it explicitly and let them decide — don't quietly do X+Y.

### 5.5 Voice and register

- **Plain prose, not consulting-speak.** "We need to decide the multi-tenancy isolation model" not "It is incumbent upon us to architect a robust isolation paradigm."
- **British English spelling.** The docs use "behaviour", "organisation", "minimised", etc. Match this.
- **Specific numbers and citations.** Not "soon" but "in 6 weeks." Not "the docs say" but "`requirements.md` §6.4 says." Cite when possible.
- **Tables and structured lists liberally** in design docs, but **prose** in chat replies. Chat formatting is conversational; doc formatting is structured.
- **Honest acknowledgement when something is genuinely hard or genuinely unknown.** Don't pretend everything is solved.

---

## 6. The toolchain

### 6.1 Where things live

- **Conversations about design and meta-work:** Anthropic Claude in claude.ai chat (this surface). Used for: writing design docs, writing prompts, reviewing diffs, verifying Claude Code output.
- **Repo work:** Claude Code at the user's Mac terminal, in `~/Desktop/workspace/hireops`. Used for: applying changes to docs, scaffolding, running tests, git operations.
- **The user's role:** orchestration. Decides what to do, pastes prompts, reviews diffs, asks for course corrections. Does not do the engineering work themselves day-to-day — Claude Code is the team.

### 6.2 What Claude in chat can do directly

- Read and analyse files the user uploads
- Search the web (use this for current facts, not memory)
- Write files into `/mnt/user-data/outputs/` for the user to download
- Reason, recommend, plan, push back, research

### 6.3 What Claude in chat cannot do directly

- Touch the user's git repo
- Run shell commands on the user's machine
- Verify that an edit actually landed in the user's repo (rely on user-pasted summaries)
- Remember anything from previous chat sessions (this handover doc is the workaround)

### 6.4 The prompt-to-Claude-Code pattern

Every prompt for Claude Code should:

1. **Open with strict scope fences.** "You will / you will not" lists. Without these, Claude Code drifts into adjacent work.
2. **Include explicit verification commands.** `pnpm typecheck && pnpm lint && pnpm build` minimum. Specific greps for things that should/shouldn't be present.
3. **Include explicit stop-and-ask instructions.** "If a passage doesn't match the description, stop and ask — don't guess."
4. **Specify a single commit at the end** with a clean message. Avoids the "47 wip commits" mess.
5. **Tell Claude Code what to print when done.** The user pastes this back; structured output makes verification fast.

For high-risk edits (renames, refactors, anything touching ownership rules or schema constraints), prescribe exact replacement text. For low-risk edits (consistency drifts, persona additions), give Claude Code more latitude on phrasing.

---

## 7. Where we are right now

**Most recent state (commit 957e093):**
- Tier 1 + Tier 2 requirements refinements landed cleanly
- 18 edits applied across `requirements.md`
- 14 personas now documented (13 tenant-facing + 1 platform admin out-of-scope)
- Notification matrix added
- Lifecycle diagram split (Pre-Hire / Hire as separate stages)
- Testability thresholds added throughout

**Next two pieces of work, in priority order:**

### 7.1 Wave 1 execution plan (recommended next)

The user has explicitly said their "team" is Claude Code. This changes phasing meaningfully. A Wave 1 execution plan should cover:

- **Sequential critical path:** FND-15a → FND-15b → FND-15c (multi-tenancy structural prep) → DB-01 → DB-02 → DB-03 → DB-08 → RLS → API-01 → ... → first vertical slice
- **Parallel-safe tracks** that can run alongside the critical path: careers site, candidate portal flows (after API-01), AI client setup, design system, internal portal pages
- **Realistic Claude-Code throughput** — how many parallel sub-tasks can one user-orchestrator manage at once? Probably 1-2 active prompts at a time, given that each prompt produces a diff that needs review
- **Sequencing of "long" tasks** — WD-04 (SOAP client) is genuinely 6 weeks of careful work; ONB-03 (document collection) is L; PRT-06 (partner submit wizard) is L. These can't all start week 1.
- **The decision on whether to write product code in parallel with design system work** — strong argument for design system first (so portal screens have a stable foundation), strong argument for parallel (so tokens/components are battle-tested by real screens). Lean toward "design system tokens + AI-component patterns first, full component library in parallel with first portals."

This should be a Claude-in-chat doc, not a Claude Code prompt. Output at `/docs/internal/wave-1-execution-plan.md`.

### 7.2 Design system spec (the original goal)

After the execution plan, lock the design system. Now genuinely safe — product is stable, multi-tenancy is locked, schemas are tenant-scoped, requirements have testability thresholds.

Spec should cover (drawing from `competitive-landscape.md`):

- **Tokens** — colours, typography, spacing, elevation. India-default currency/date/timezone
- **AI-component catalogue** — explicit patterns for AI-suggested-input, AI-score-with-explanation, AI-thinking, AI-error, AI-override
- **Density grid** — comfortable / compact / dense (three levels)
- **Data-table pattern** — single component handling 10 to 10,000 rows, server pagination, virtualisation, column resize/reorder/hide, bulk-select
- **Persona-specific layouts** — same shell, different navigation per role
- **Mobile breakpoints and budgets** — per the §3.1 mobile interaction budget added in Tier 1
- **Localisation rules** — text expansion budgets (Hindi 30-40% longer)
- **Accessibility tokens** — WCAG 2.1 AA baked into colour contrast minimums
- **AI principles document** — public-facing, FairNow-style. Bias auditing commitment, model selection criteria, override paths.

The spec is anchored to the competitive bar: **"Ashby quality, Workday-grade integration, Greenhouse-level rigour, with Indian GCC fluency."**

### 7.3 What's NOT next (in priority order, but later)

- Kyndryl admin spec (deferred when partner-wireflows scope was narrowed)
- Workday field-mapping document
- Tenant-onboarding wizard spec
- Tier 3 requirements cleanup
- Wave 1 build can begin in earnest after the design system + execution plan land

---

## 8. Quick-reference index

If you need to look something up:

| Topic | Where |
|---|---|
| Why HireOps is multi-tenant SaaS | `requirements.md` §1.5, `architecture.md` §1.1 |
| Personas and their workflows | `requirements.md` §3 |
| Lifecycle state machine | `requirements.md` §4 |
| Recruitment requirements | `requirements.md` §5 |
| Partner sourcing rules | `requirements.md` §6, `partner-wireflows.md` |
| Onboarding requirements | `requirements.md` §7 |
| Offboarding requirements | `requirements.md` §8 |
| Workday integration | `workday-adr.md` |
| Multi-tenancy architecture | `multi-tenancy-adr.md` |
| Partner schema | `partner-data-model.md` |
| What we're benchmarked against | `competitive-landscape.md` |
| Wave 1 task breakdown | `internal/wave-1-backlog.md` |
| Resolved contradictions | `internal/open-questions.md` §a |
| Resolved gaps | `internal/open-questions.md` §b |
| Kyndryl POC config items | `requirements.md` §12 |
| Testability thresholds | scattered across `requirements.md` §3.1, §5.4, §6.6, §6.7, §7.2, §7.3, §9.2, §9.6 |

---

## 9. First action for the next Claude

When the user types something into the new conversation after pasting this:

1. **Confirm you've internalised the handover** in one short reply. Mention what you understand to be the immediate next step. Do not re-summarise the project — the user wrote it, they don't need it back.
2. **If they're picking up where we left off**, the natural next prompt is the Wave 1 execution plan. Ask them to confirm before you start writing.
3. **If they're pivoting** to something else, follow them. The handover gives you context, not a script.
4. **If they want the design system first**, push back gently — execution plan first lets the design system be sequenced realistically against build dependencies. But if they insist, defer.

Do not start writing major artefacts in your first reply. Confirm context first, then ask what they want next.

Be honest if something in this handover doc seems wrong or stale by the time you read it. The user trusts honesty over consistency.

---

## 10. The voice

Match what's been working:

- Push back when something's wrong, even if pushing back means more work
- Recommend and explain rather than offering menus, except when the user explicitly wants options
- Research current facts with web_search rather than claiming from memory
- Write Claude Code prompts with strict scope fences
- Cite sections and commits, not "I think" or "somewhere"
- Acknowledge uncertainty honestly
- British English, lowercase-friendly tone, dense technical prose
- Don't be sycophantic. Don't open with "Great question!" The user finds this irritating.
- Don't waste their time with recaps when they already know the context

The user is building something real. Treat the work that way.
