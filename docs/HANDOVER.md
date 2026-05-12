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
- **FND-15d — NOT STARTED.** KMS envelope encryption: DEK generation, KMS-wrap on insert, DEK cache + unwrap on read, KEK rotation runbook. Per ADR-002 §5.5.
- **FND-15e — NOT STARTED.** Tenant-context middleware: subdomain extraction in Next.js, JWT `tid` validation in Hono, AsyncLocalStorage propagation. Was originally FND-15c — renumbered when this set landed.
- **FND-15f — NOT STARTED.** Tenant onboarding workflow MVP. Depends on 15c, 15d, 15e, plus INT-01.

**Codebase realities introduced by FND-15c:**

1. **RLS framework via lint script.** `packages/db/src/lint-rls.ts` is the source of truth for which tables are tenant-scoped vs platform. Every new table added in a migration must either satisfy the tenant-isolation policy contract or be added to the `PLATFORM_TABLES_ALLOWLIST` set in that script with a justifying comment. Don't disable the lint; if it fails, fix the schema.
2. **Auth hook reads require `supabase_auth_admin` policies under FORCE RLS.** The Custom Access Token hook runs as `supabase_auth_admin`, which does NOT bypass RLS. Any table the hook reads (currently `tenants` and `tenant_user_memberships`) must have an explicit policy granting `supabase_auth_admin` SELECT — otherwise the hook silently returns no custom claims and the JWT goes out missing `tid`/`tenant_slug`/`roles`. Symptoms: JWT looks valid, sign-in succeeds, but `current_tenant_id()` returns null in RLS policies. Diagnosis: invoke the hook function directly via SQL — if direct invocation produces correct claims but sign-in JWT doesn't, you're hitting this. See migration `0003_rls_baseline.sql` for the policy pattern.
3. **`tenant_encryption_keys` is allowlisted and policy-less.** RLS+FORCE on, no policies → default-deny for `authenticated`. `service_role` (BYPASSRLS) is the only legitimate access path. Don't add an authenticated-role policy here — the DEK store must never be reachable via a user JWT.
4. **Migrations apply via session-mode pooler.** `DIRECT_URL` is `aws-N-<region>.pooler.supabase.com:5432` (dual-stack IPv4+IPv6). The error string in `migrate.ts:15` documents this. If you see "This must be the direct connection" anywhere, it's an outdated comment and needs updating.
5. **Supabase pause/resume can reset auth-hook dashboard registration.** Observed twice during FND-15c. Symptoms: SQL side intact, function works in direct invocation, but JWT has no custom claims after sign-in. Recovery: re-enable the hook via dashboard (Authentication → Hooks → Customize Access Token (JWT) Claims → toggle on, source Postgres, schema public, function `custom_access_token_hook`, save). Wait ~60s for propagation before retesting. The `diagnose-hook.ts` script isolates function correctness from dashboard registration — run it first to confirm you're chasing the right failure mode.

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
