# HireOps — Wave 1 Execution Plan

**Status:** v1, May 2026
**Audience:** Solo orchestrator (the user) running Claude Code as the build team
**Purpose:** Sequence the 158 Wave 1 tasks into executable phases under realistic single-orchestrator constraints. This document is not the backlog (`wave-1-backlog.md`) and not the architecture; it is how the work actually gets done given how it gets done.

---

## 1. The orchestration reality

The original `requirements.md §11` plan assumed "8-12 engineers + 2 designers + PM + Workday integration specialist + DevOps + QA." That world produces one set of trade-offs. The actual world produces a different one: **one human orchestrator, Claude Code as the build team.** This plan is built for the actual world.

### 1.1 The bottleneck is review bandwidth, not compute

Claude Code can run as many parallel sessions as you spawn terminal tabs. The constraint isn't its capacity; it's yours. Every prompt produces a diff. Every diff has to be read, understood, verified against intent, often corrected. Quality of review degrades fast past two simultaneous in-flight prompts — you start rubber-stamping, which is how subtle bugs ship.

**Working assumption: 1-2 active prompts at any moment.** Not five. Not ten. The plan respects this.

### 1.2 Claude Code is not a free resource

Each prompt costs API time. Each prompt also costs your time on the front (writing) and back (reviewing). Running five prompts in parallel doesn't 5x throughput — it 1.5-2x it, because review serialises.

### 1.3 Some work doesn't parallelise even in principle

The critical-path tasks (multi-tenancy prep → schema → RLS → API auth → first vertical slice) are sequential by dependency. No amount of orchestration changes this. Acknowledging it up-front sets honest expectations.

### 1.4 Compressed timelines vs human-team timelines

The Workday ADR estimates 6 weeks for a human Workday specialist. With Claude Code orchestrated well, that compresses — Claude Code writes the SOAP wrapper much faster than a human. But reconciliation logic, BP polling edge cases, WS-Security debugging still take real review time. Realistic compression: **3-4 weeks of orchestrated work vs 6 weeks of solo human work.** Not 1 week. Don't plan for magic.

The same compression applies broadly across Wave 1. The 24-week original estimate (assuming a 6-12 person team) compresses to roughly **11-13 weeks for a solo orchestrator** if Claude Code is used well — but only because so much of that 24-week estimate was coordination overhead (PRs, design reviews, sync meetings, handoffs) that doesn't apply when one person owns the whole thing.

---

## 2. Phasing — four phases, not 12 tracks

The 158-task backlog organises around 12 functional tracks. Functional tracks are not how the work actually gets done. The work gets done in phases: bedrock first, then a vertical slice, then fan-out, then hardening. This is the same shape Anthropic's own engineering teams use for greenfield products, and it's the right shape here.

### Phase 1 — Bedrock (weeks 1-3)

**One thread of sequential work.** Nothing else starts. Everything downstream depends on Phase 1 being solid.

What lands by end of Phase 1:
- `tenants` table provisioned with one synthetic tenant ("kyndryl-poc") seeded
- `tenant_encryption_keys` + KMS wrapping flow tested
- `current_tenant_id()` SECURITY DEFINER helper function operational
- JWT custom claim `tid` propagating from Supabase Auth login hook through to RLS
- Tenant context middleware: subdomain extraction in Next.js, JWT validation in Hono, AsyncLocalStorage propagation
- All foundational schema migrated: identity (`persons`, `candidates`, `employees`), positions/headcount, requisitions/jobs, applications/interviews, candidates ownership claims with the tenant-scoped partial unique index
- RLS policies on every table written and tested with the tenant-aware testing utility
- `packages/db` migration framework with PR-gated migration discipline
- `packages/config` shared env loading with secret manager hooks
- `packages/types` populated with domain types
- Initial design tokens in `packages/ui` (CSS variables for colour, typography, spacing, status colours)
- CI green: `pnpm typecheck && pnpm lint && pnpm build` plus a new RLS-coverage check that fails if a table is created without RLS policies
- Sentry, Datadog APM, structured logging wired into `apps/api` and `apps/workers`
- SSO bridge to a synthetic IdP for the synthetic tenant (real Kyndryl IdP integration deferred to Wave 2/3 cutover)

**Backlog tasks in Phase 1:** FND-15a, FND-15b, FND-15c, FND-15d, FND-15e, DB-01 through DB-09, DB-13 through DB-17, DB-22, DB-24 through DB-32, FND-01 through FND-05, FND-07, FND-09, FND-10, FND-11, FND-13, FND-14, AI-01.

That's roughly 40 tasks. They run in a tight chain because each unlocks the next. Estimated: **3 weeks of orchestrated work** with steady review cadence.

**What's NOT in Phase 1:**
- Anything that touches the API layer beyond skeleton (deferred to Phase 2)
- Any portal screen work (deferred to Phase 2 or later)
- Any external integration beyond Sentry/Datadog (deferred to Phase 2 or later)

### Phase 2 — First vertical slice (weeks 3-7)

**Goal: one candidate flows end-to-end through the system.** Career site apply → application created → recruiter sees it in internal portal → recruiter moves through stages → offer drafted → offer accepted → Workday Pre-Hire fires. By end of Phase 2, this works on a synthetic tenant with synthetic data, and you can demo it.

This phase introduces controlled parallelism. Two threads:

**Main thread (sequential):**
- API skeleton in `apps/api` — Hono + tRPC + audience-scoped JWT verification (API-01)
- Permission middleware combining tenant scoping with RBAC/ABAC (API-02)
- Audit logger middleware (API-03)
- File upload pipeline with S3 presigned URLs and KMS (API-04)
- Application intake endpoint (API-07)
- Resume parser worker (API-08, AI-02)
- Synchronous dedup service (API-09) — the database-level guarantee
- Stage transition endpoints (API-10)
- Internal portal app shell (INT-01) and SSO login (INT-02)
- Recruiter dashboard, candidates list, candidate detail (INT-03, INT-04, INT-05)
- Recruiter shortlist (INT-06)
- Careers site scaffold + apply form (CRS-01, CRS-02, CRS-03, CRS-04)
- AI scoring MVP (API-16) — single Anthropic call per candidate, score + top-3 contributing factors
- Offer drafting + approval (API-13, INT-13)
- Offer e-signature integration (API-14, CND-08)
- Notification dispatcher MVP, email-only (API-15)

**Side thread (parallel, lower-priority):**
- Workday client foundation in `packages/workday-client` — SOAP envelope templates, REST + WQL client, OAuth token cache (WD-01, WD-02, WD-03, WD-04, WD-05)

The Workday foundation work runs alongside the main thread because it's mostly mechanical wrapper code that doesn't depend on the application schema. By the time the main thread reaches "offer accepted," the Workday wrapper is ready to receive the Pre-Hire trigger. This is the only meaningful parallelism in Phase 2.

**Backlog tasks in Phase 2:** API-01 through API-04, API-07 through API-10, API-13 through API-16, INT-01 through INT-06, INT-13, CRS-01 through CRS-05, AI-02, WD-01 through WD-05, WD-10 (Pre-Hire only — Hire fires in Phase 3 as part of onboarding). Approximately 30 tasks.

Estimated: **4 weeks of orchestrated work.** This is the hardest phase to estimate because it has the most novel design decisions (the actual UI patterns for recruiter screens, the apply flow UX). Some of this depends on how the design system implementation tracks alongside (see §4 below).

**Demo at end of Phase 2:** "Watch this candidate apply through the career site, get scored by AI, get reviewed by a recruiter, get an offer drafted and approved, accept the offer via DocuSign, and trigger a Workday Pre-Hire record."

### Phase 3 — Fan-out (weeks 7-11)

**Now multiple threads can run.** The critical path is established. Patterns are proven. New work follows established patterns.

This is where Wave 1's breadth gets delivered: partner portal, candidate portal post-apply flows, onboarding minimum, offboarding minimum, AI hardening.

**Threads that can run in parallel (review-bandwidth-bounded — typically 2 at once):**

**Thread A — Partner portal:**
- Partner auth setup (FND-08), magic-link login + MFA, accept-invite flow (PRT-01, PRT-02)
- Partner dashboard, open reqs, req detail (PRT-03, PRT-04, PRT-05)
- Single-candidate submit wizard (PRT-06) — the ownership state machine in action
- Pipeline view + candidate detail (PRT-07, PRT-08)
- Team management (PRT-10)
- Partner-data-model schema additions (PRT-11)
- Email-intake parser (EMI-01 through EMI-08)
- Admin invite-partner flow (INT-21)

**Thread B — Candidate / onboarding / offboarding:**
- Candidate portal app shell + auth (CND-01, CND-02)
- Apply flow, profile, applications tracker (CND-03 through CND-05)
- Interview scheduling (API-11, API-12, INT-15, INT-16, INT-17, CND-06)
- Document upload (CND-07)
- Onboarding case state machine (ONB-01)
- Pre-board welcome flow (ONB-02)
- Document collection with geography-specific document_types (ONB-03)
- BGV vendor integration with HMAC-secured webhooks (ONB-04, ONB-05)
- IT provisioning queue + manual SCIM stub (ONB-06)
- Day 1 checklist + probation tracker (ONB-07, ONB-08)
- Onboarding case → Workday Hire trigger (ONB-09)
- Workday Hire + BP polling (WD-06, WD-07, WD-11)
- Workday Terminate two-step (WD-12)
- Offboarding flows (OFF-01 through OFF-09)

**Thread C (smaller, intermittent) — Internal portal completion:**
- HM dashboard + create-requisition wizard (INT-07, INT-08)
- JD builder + library + skill weights (INT-09, INT-10)
- Approval tracker (INT-11)
- HR Ops cases board, document collection UI (INT-12, INT-14)
- Admin user/role management, integrations health, audit view (INT-18, INT-19, INT-20)
- DPDPA endpoints (API-17)

**Backlog tasks in Phase 3:** roughly 80 tasks. Estimated: **4 weeks** if your review bandwidth holds and Threads A and B can both run actively. If review bandwidth tightens, Thread C goes last and Phase 3 stretches into Phase 4 territory.

**Demo at end of Phase 3:** "Watch this hire flow through the entire system end-to-end, including partner submission, full onboarding through Day 30, and a separate hire that's already through their probation entering offboarding."

### Phase 4 — Hardening (week 11)

**One thread of work, focused on what makes the demo defensible.**

- Workday daily reconciliation (WD-13, WD-14)
- Failure-mode handling matrix per `workday-adr.md` §5.7
- Observability completion: dashboards, alerts, runbooks
- DPDPA audit prep: consent flow review, retention job validation, audit log spot-checks
- Performance hardening: critical query indexes verified, RLS policy performance tested at synthetic-volume
- Demo data seeding: 50 synthetic candidates across various stages, 10 hires in onboarding, 3 partners with realistic submission histories
- Demo runbook: scripted demo flow with timing, failure recovery
- Final cleanup: lint warnings, TypeScript any-types, TODOs

**Backlog tasks in Phase 4:** roughly 8 tasks plus cleanup. Estimated: **1 week.**

**End-of-Wave-1 demo:** the full thin slice running end-to-end on a synthetic tenant. Ready for Kyndryl POC tenant onboarding to begin Wave 2.

### 2.5 Total timeline

| Phase | Duration | Tasks | Parallelism |
|---|---|---|---|
| Phase 1 (Bedrock) | 3 weeks | ~40 | Sequential, single thread |
| Phase 2 (Vertical slice) | 4 weeks | ~30 | Two threads (main + Workday foundation) |
| Phase 3 (Fan-out) | 4 weeks | ~80 | Two-three threads |
| Phase 4 (Hardening) | 1 week | ~8 + cleanup | Sequential |
| **Total** | **12 weeks** | **~158** | — |

12 weeks is one week longer than the original 11-week Wave 1 estimate. This is honest — solo orchestration with Claude Code isn't faster than a 6-12 person team for raw build work; it's faster on coordination and slower on review. Net: roughly the same wall-clock, less overhead, lower headcount cost.

---

## 3. Where the design system fits

The original instinct was "design system before any portal screens." That's wrong for a sequential builder. The right model: **design system in three layers, each landing at the right moment.**

### Layer 1 — Tokens and primitives (Phase 1)

Lands during the bedrock phase. Tokens defined as CSS variables in `packages/ui`:
- Colour scale (neutrals + status colours)
- Typography scale (display, heading, body, code)
- Spacing scale (4px-based)
- Elevation tokens
- Density tokens (the three-level density grid: comfortable / compact / dense)
- India defaults (₹, IST, dd-mm-yyyy, Hindi-capable text)
- WCAG-AA contrast pairs baked in

Plus the absolute foundational primitives:
- Button (primary / secondary / tertiary / destructive)
- Input (text / number / textarea)
- Select / Combobox
- Checkbox / Radio / Switch
- Card / Container
- Stack / Inline (layout primitives)

Eight primitives. Built once, used everywhere. Storybook scaffolded so future components have a place to land.

### Layer 2 — Domain components (Phase 2)

Lands as Phase 2 portal screens get built. Components emerge from real screens, not from a wishlist:
- DataTable — the single component that handles 10 to 10,000 rows. Built when the recruiter candidates list (INT-04) needs it.
- StatusBadge — built when stage transitions need to be displayed.
- AvatarStack — built when applications need to show submitter context.
- KPI Tile — built when the recruiter dashboard (INT-03) needs it.
- Form patterns (FormField, FormSection, FormActions) — built when the apply form and submit wizard need them.
- Empty / Loading / Error states — built into the data-fetching primitives.

These are a few weeks of work, but spread across Phase 2 — not a separate phase. Each component is built when its first consumer needs it, then reused.

### Layer 3 — AI-component catalogue (Phase 2-3)

Built explicitly as an early Phase 3 priority because it's load-bearing for partner portal AI features and recruiter AI scoring. Five core patterns:
- AI-suggested-input — placeholder text becomes editable suggestion
- AI-score-with-explanation — number + top-3 contributing factors, expandable
- AI-thinking — loading state for long async calls
- AI-error — graceful failure with manual fallback
- AI-override — visible affordance for users to overrule AI output

These get their own focused work — not retrofitted into existing primitives. The Ashby benchmark consistency depends on these patterns existing as first-class components, not as ad-hoc compositions.

### When to write the design system spec doc

**During Phase 1**, parallel to the bedrock work but ahead of Layer 2 component work in Phase 2. The spec lives at `/docs/design-system.md`. It's written by Claude in chat, not by Claude Code, because it's judgement work like this execution plan.

The spec drives Layer 1 directly: tokens are implemented from the spec. It serves as the contract for Layers 2 and 3, but those layers' actual implementations get refined as real screens consume them.

---

## 4. Where Claude Design fits

Claude Design (research preview, launched 17 April 2026, included in your Pro/Max subscription) is a candidate accelerator for **Phase 3 portal screens**, specifically: partner portal screens, internal portal HM dashboard, internal portal HR Ops case board.

It is not a substitute for the design system spec. The value of Claude Design comes from feeding it your design system; without one it'll produce visually generic prototypes.

**The right evaluation point: end of Phase 2 / start of Phase 3.** By then:
- `packages/ui` has tokens and primitives implemented (Phase 1 deliverable)
- The first vertical slice is working (Phase 2 deliverable)
- You have a few real screens to compare prototype-vs-production for quality
- You have ~80 tasks of Phase 3 ahead of you, many of which involve portal screens that prototype well

**The evaluation:** point Claude Design at `packages/ui` + your design system spec. Generate a prototype for one Phase 3 screen — the partner portal dashboard is a good candidate. See how the output compares to building the screen via Claude Code prompt against the design system. If it's high-quality and consistent with the system, use it for the rest of Phase 3 portal screens. If it's hit-or-miss, stay with the Claude-Code-against-design-system pattern and use Claude Design selectively for lower-stakes work (pitch decks, marketing one-pagers, onboarding wizard mockups).

The handoff bundle from Claude Design to Claude Code is the differentiating feature. If it works for your design vocabulary, Phase 3 portal work compresses meaningfully. If it doesn't, you've lost half a day of evaluation, not a week.

**This is not load-bearing.** The plan delivers Phase 3 either way. Claude Design is an accelerator, not infrastructure.

---

## 5. The orchestration cadence

A practical pattern that survives 12 weeks of solo orchestration:

### Daily rhythm
- **Morning block (deep work):** write or refine a Claude Code prompt for the next task. Test scope fences, verification commands. Paste into Claude Code.
- **Mid-day block (review):** review whatever Claude Code produced overnight or earlier. Verify diff against intent. Spot-check the changes that matter (RLS policies, ownership rule logic, schema constraints). Commit or push back.
- **Afternoon block:** depending on review outcome, either approve and move to next prompt, or write a corrective prompt if the diff missed something.

### Weekly rhythm
- **Mondays:** plan the week. Pull next ~5-7 tasks from the current phase. Write the first prompt. Schedule which days are prompt-writing-heavy vs review-heavy.
- **Mid-week:** reassess. Tasks that exceeded estimates flag for breakdown. Tasks that finished early get spot-checked.
- **Fridays:** integration check. Run the full demo path end-to-end (whatever's built so far). Document what works. Note what's flaky.

### Avoid these failure modes
- **Running 5 prompts in parallel because Claude Code can handle it.** Your review bandwidth can't. Diffs accumulate, quality drops, bugs ship.
- **Writing one giant prompt instead of a sequence of small ones.** Big prompts are hard to verify. Each prompt should produce a reviewable diff. If Claude Code's summary requires more than 10 minutes to verify, the prompt was too big.
- **Skipping the verification commands.** Every prompt should print verification output (test results, grep counts, line counts). When you skip checking these, regressions slip in.
- **Letting open questions accumulate.** Address them as they come up. The contradiction-resolution pass and Tier 1+2 refinement pass were both clean-up of accumulated open questions; better to not let them accumulate next time.

---

## 6. What this plan deliberately does NOT cover

These belong in other documents or are out of scope for Wave 1:

- **Wave 2 and Wave 3 sequencing.** Beyond noting that bulk operations, full AI scoring + bias shield, partner commercials with content scanning, and job-board posting land in Wave 2; pen-test, DR drills, full panel ramp, and Kyndryl tenant onboarding land in Wave 3.
- **Kyndryl tenant onboarding flow.** Defined in `multi-tenancy-adr.md` §5.6 as a product feature. The Wave 1 deliverable is "platform ready to onboard Kyndryl as Tenant #1," not "Kyndryl is onboarded." The actual onboarding happens in Wave 2 transitioning into Wave 3.
- **The Workday field-mapping document.** Deferred per `workday-adr.md` §7. Will need to be written in Phase 2 once we have access to a Workday sandbox tenant.
- **Tenant-onboarding wizard spec.** Comparable in scope to `partner-wireflows.md`. Needed before Phase 3 admin work, but is a Phase 2-3 sub-deliverable rather than a separately-tracked artefact.
- **Kyndryl admin spec.** Deferred when partner-wireflows scope was narrowed. Real work, will need to land before Wave 2 partner-management features ship.

These are flagged in the handover document; they don't block Wave 1 execution.

---

## 7. Definition of Wave 1 success

Wave 1 is successful when:

1. A candidate can apply through the career site, be screened by AI, be reviewed by a recruiter, accept an offer via DocuSign, and have a Workday Pre-Hire record created automatically.
2. A partner can be invited, log in, see open reqs, submit a candidate against a req, see that candidate move through the pipeline.
3. The Day 1 Workday Hire fires automatically on the candidate's first working day, the BP completes (or surfaces failure cleanly), and the worker_wid lands in HireOps.
4. Onboarding cases progress through document collection, BGV verification, IT provisioning queue, and Day 30 check-in milestones.
5. An employee can submit a resignation, the manager acknowledges it, and the offboarding workflow completes through Workday Terminate.
6. The platform runs on a synthetic tenant with multi-tenancy semantics fully active — every query is tenant-scoped, every credential is per-tenant encrypted, the tenant onboarding flow is functional.
7. Daily reconciliation jobs are running and surfacing drift correctly.
8. All `pnpm typecheck && pnpm lint && pnpm build` green; CI gates passing; observability (Sentry, Datadog) catching errors with tenant context attached.

This is "thin slice that proves the platform end-to-end on synthetic data," not "ready for 300 hires/month." Wave 2 takes us to volume.

---

## 8. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-09 | 4-phase structure (Bedrock / Vertical Slice / Fan-out / Hardening) instead of 12 functional tracks | Functional tracks describe the work; phases describe how it gets done under solo orchestration |
| 2026-05-09 | Working assumption of 1-2 active prompts max | Review bandwidth is the real bottleneck, not Claude Code compute |
| 2026-05-09 | 12 weeks total (vs original 11) | Honest estimate accounting for solo-orchestrator review serialisation |
| 2026-05-09 | Design system in three layers, each landing at its consumer | Avoids the "build everything before any screens" trap |
| 2026-05-09 | Claude Design evaluated end of Phase 2 | Need a working `packages/ui` + real screens for meaningful comparison |
| 2026-05-09 | Workday integration starts in Phase 2 as a side thread | Mechanical wrapper code parallelises with main thread; reconciliation lands in Phase 4 |

(Future amendments to this plan should be appended here, not edited inline.)
