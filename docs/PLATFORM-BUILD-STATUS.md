# HireOps — Platform Build Status & Handoff

**Purpose.** This is the master status + scope + roadmap document. Paste it at the start of a new build session to know, without re-deriving anything: exactly where the build is, what remains for the **August demo**, and what remains for the **full platform**. It is the "what to build next" companion to `docs/HANDOVER.md` (which is the ticket-level changelog + deep codebase realities — read that when you need the *why* behind a specific implementation).

**Last updated:** 12 July 2026, after the fast-track sprint days 1–2 (branch `feat/followup-01-real-executors`, tip `ed04eff`). Demo-critical items §4 #1–5, #9 (minus pii_access_log), and #10 are DONE; the remaining path is external infra (#6 Resend, #7 staging, #8 credential) plus two small in-house tickets (pii_access_log; agent-runtime robustness follow-ups).

**Read alongside this doc:**
- `docs/requirements.md` — the full product requirements (the denominator for §5 below).
- `docs/new-set/build-plan-13week.md` — the 13-week demo build plan (the schedule).
- `docs/new-set/demo-scope-v2.md` — the exact demo script (Acts 1–3).
- `docs/HANDOVER.md` — §0 current position + the numbered "codebase realities" (#1–112). The ticket log is the de-facto changelog.
- `docs/architecture.md`, `docs/workday-adr.md`, `docs/multi-tenancy-adr.md` — the locked architectural decisions.

---

## 1. What HireOps is (30-second version)

A **multi-tenant SaaS ATS** for enterprise hiring — full lifecycle (recruitment + onboarding + offboarding), Workday as HRIS-of-record, HR-partner sourcing as a first-class channel. Closest comparables: Ashby / Greenhouse. Multi-tenant from day one; **Kyndryl's GCC is Tenant #1**, funding the build via a paid POC. Business model, personas, and scale numbers are in `docs/HANDOVER.md` §1 and `docs/requirements.md` §1.5.

**The wedge** (the POC's differentiator, added after the original requirements): HR-configurable **agents** that handle scheduling, follow-ups, and candidate Q&A with human-in-the-loop approval and full audit. "AI you can audit."

---

## 2. Where we are — one screen

**Calendar:** 11 July 2026. The 13-week demo plan puts this at **week 7 of 13**; demo target is **24–30 August 2026** (~6.5 weeks out).

**What's actually built** is one vertical stripe of the platform plus a strong foundation:
- **Foundation (disproportionately strong):** multi-tenancy with FORCE RLS + compound-tenant FKs, per-tenant envelope encryption, audit logging, pino+Sentry observability, a pluggable AI client, pluggable storage, the outbox+worker pattern, and the agent runtime.
- **Recruitment thin-slice:** requisition → apply → resume-parse → AI-score → recruiter triage → offer → **simulated** Workday hire. This is Acts 1 & 3 of the demo.
- **Agent wedge (the demo differentiator):** the follow-ups agent works **end-to-end** (draft via LLM → human approval → send), and the recruiter-facing **approval queue UI** ships. This was the biggest risk and it's retired.

**What's NOT built** is most of the product: three whole pillars — **onboarding, offboarding, and the partner portal + commercials** — are at 0–25% (schema-or-nothing), and the production cross-cutting layer (reporting, search, bulk ops, real Workday connector, real notification delivery, SSO) is largely absent. Full-platform completion is **~15–20%** (see §5).

**The week-7 contingency decision (in force):** the 13-week plan front-loaded an admin surface + production-readiness in weeks 1–2 that mostly never got built, and the weeks 3–5 scheduling agent never started. Per the plan's own contingency rule 1, **scheduling and candidate Q&A are cut from the demo to the onboarding window; the follow-ups agent is taken all the way.** `demo-scope-v2.md` Act 2 still narrates the cut agents and needs rewriting (see §4).

**The rule-2 fuse:** if the demo won't be ready for 24–30 Aug, Rajesh & Lakshmi must be told by **week 9 (~24 July 2026)** — don't surprise anyone in week 12.

---

## 3. Current state in detail — what exists

### 3.1 Repository shape
Monorepo: pnpm 11 + Turborepo + Node 22 LTS + TypeScript 5 strict. Apps: `api` (Hono + tRPC), `workers` (BullMQ-style polling loops), `internal-portal` (Next.js 14 App Router). Three empty `export {}` stubs remain (`candidate-portal`, `careers-site`, `partner-portal`) — pending deletion or build. Packages: `db`, `ui`, `api-types`, `ai-client`, `ai-scoring`, `agent-actions`, `notifications`, `email-templates`, `observability`, `sla-thresholds`, `types`, `config`, `workday-client`.

### 3.2 Database (~50 tables, all tenant-scoped unless noted)
- **Tenancy/identity:** `tenants`, `tenant_encryption_keys`, `tenant_user_memberships`, `users`, `integration_credentials`.
- **Org/req:** `business_units`, `headcount_envelopes`, `positions`, `jd_versions`, `jd_skills`, `requisitions`, `requisition_recruiters`, `requisition_knockouts`, `requisition_state_transitions`.
- **Candidates:** `persons`, `candidates`, `applications`, `application_state_transitions`.
- **Partner (schema only):** `partner_orgs`, `partner_users`, `partner_invitations`, `partner_assignments`, `candidate_ownership_claims`, `candidate_dedup_attempts`, `partner_candidate_messages`, `ad_hoc_partner_domains`, `candidate_inbound_messages`.
- **Offers/Workday:** `offers`, `workday_sync_outbox`.
- **Notifications:** `notification_outbox`, `dev_email_outbox`, `signed_link_uses`, `scheduled_job_runs`.
- **AI/audit:** `ai_usage_logs`, `ai_score_outbox`, `audit_logs` (monthly-partitioned), `api_audit_logs`.
- **Generic approvals (schema, unwired):** `approval_chains`, `approval_matrices`, `approval_requests`, `approval_decisions`.
- **Agent runtime:** `automation_agents`, `agent_triggers`, `agent_actions`, `agent_approval_rules`, `agent_runs`, `agent_run_actions`, `agent_run_outbox`, `agent_approval_requests`.

### 3.3 What works end-to-end today
- **Apply → hire-sim:** public apply form (`/t/[tenant]/apply/[req]`) → resume parse → knockout eval → AI score → triage (`/triage`, Hot Zone + Momentum) → offer draft/extend → candidate accept via signed link (`/offer/[token]`) → simulated Workday hire → admin Integration Health (`/admin/integrations`).
- **Follow-ups agent:** `draft_message` (real LLM via `@hireops/ai-client`) and `send_message` (real `notification_outbox` enqueue) executors; the approval **gate sits on the pure `draft_message`**, not the effectful send (see reality #111). Configurable via the agent CRUD procedures.
- **Approval queue UI:** `/approvals` — recruiter reviews the drafted message, edits, approves → the send runs and the email dispatches. Verified end-to-end in the browser this session.

### 3.4 Operational realities you must know (learned this session — save yourself the pain)
- **Node 22 required.** pnpm needs Node ≥22.13. Use `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"` before any `pnpm`.
- **Commit gate:** `pnpm test:gate` (~12 min) = agent-actions unit tests + targeted api tests. It is the local gate; full `pnpm api:test` is unreliable on the Supabase pooler (realities #107/#109). Also run `pnpm typecheck` + `pnpm lint` (both ~19 tasks).
- **Dev servers:** `pnpm dev` runs api (3001) + portal (3002) + workers. **Port 3002 collides with the user's separate AURA project** — run the portal on **3003** (`next dev -p 3003`); the api CORS already allows 3003. Under many file watchers the portal hits `EMFILE`; start it with `WATCHPACK_POLLING=true`.
- **Test users:** `recruiter1@kyndryl-poc.test`, `hr_ops1@…`, `admin1@…`, password `TestPassword123!`. Seed via `pnpm db:seed:test-users`. Demo data: `pnpm db:seed:demo-data` (occasionally hangs on the pooler; kill + retry). **Neither seeds agents/approvals** — a pending-approval demo seed still needs writing.
- **`audit_logs` partitions must be pre-created** or every audited write fails (reality #112). Migration `0042` covers through 2027-06; this recurs annually until an auto-rotation job ships (open-question #35).
- **`tsx` doesn't hot-reload cross-package `.tsx`** (the email templates). After editing a template, **restart the worker** or the change won't take. Every email template needs the `@jsxRuntime automatic @jsxImportSource react` pragma or the worker throws "React is not defined" (reality: the FOLLOWUP-01 JSX fix).
- **The demo tenant has no Anthropic credential.** AI scoring and agent drafts need a real key stored via `storeIntegrationCredential` (integration_type `ai_anthropic`), or `AI_CLIENT_MODE=local` + fixtures. For demo, wire a real key.

---

## 4. The demo — what's needed for 24–30 August

Demo script: `docs/new-set/demo-scope-v2.md` (Acts 1–3). Under the week-7 contingency (scheduling + Q&A cut), the demo's thesis is: **HR configures an agent → the agent drafts with Claude → a human approves → it sends → the audit trail shows all of it**, wrapped around the working apply→offer→sim-hire slice.

### Demo-critical pending work — status as of 12 July 2026
1. ~~**`/admin/workflows` UI**~~ **DONE** (`2255707`, ADMIN-01) — list, detail drill-in (new `getAgentDetail`), toggle, run history.
2. ~~**Audit list view**~~ **DONE** (`9ce008f`, ADMIN-02) — `listAuditEvents` (keyset-paginated) + `/admin/audit` with Agent-activity preset + before/after diff expand.
3. ~~**Cost dashboard**~~ **DONE** (`1c940d7`, ADMIN-03) — `getAiUsageSummary` + `/admin/costs` (tiles, per-feature/model, 14-day bars, USD).
4. ~~**`stage_stale` scanner worker**~~ **DONE** (`1e65496`, WORKER-01) — 15-min scheduled scan, SQL-level one-shot dedup per (agent, application).
5. ~~**Agent + pending-approval demo seed**~~ **DONE** (`0751e01`, SEED-01) — one idempotent seed provisions the agent (stage `tech_interview` — the old hand-made agent watched a nonexistent label), Rohan (pending approval, works without an AI credential) + Meera (scanner live-fire target). **Runbook rule: re-run the seed after any `test:gate`.**
6. **Resend email provider + DNS** — replace `RealEmailProviderStub` (throws today); verify DKIM/SPF/DMARC. **External — user setting up DNS now.** *(≈1 session + propagation wait)*
7. **Staging deployment** — decided shape: Vercel (portal) + Fly.io (api + workers, per §3.5 ADR) + separate staging Supabase. No deploy manifests yet. Known landmines: portal dev script + logout fallback + `serverActions.allowedOrigins` hardcode 3002; email-template changes need a worker restart; `audit_logs` partitions must exist. *(≈1–2 sessions)*
8. **Real Anthropic credential** for the demo tenant (`ai_anthropic` via `storeIntegrationCredential`). *(≈½ session, mostly config)*
9. **Hygiene** — ~~delete 3 empty apps, nav/link audit, privacy check~~ **DONE** (`ed04eff`, HYGIENE-01: stub apps deleted, shared role-aware PortalHeader on all 6 portal pages, 10-link inventory zero 404s). **Remaining: `pii_access_log` table + middleware** (own ticket). *(≈½ session)*
10. ~~**Rewrite `demo-scope-v2.md` Act 2**~~ **DONE** (`0e70f8f`) — follow-ups-only arc, optional live-fire step with scripted fallback, risks + checklist updated.

**New (from SEED-01/WORKER-01 findings, small robustness ticket):** scan-test leaks outbox rows onto ambient agents; drain-side defensive skip for pending rows matching awaiting_approval runs (poisoned-resume hazard); `/approvals` lists approvals whose run already failed; `createFollowUpAgent` accepts any stage string (no enum check). *(≈½–1 session, post-demo acceptable except the drain skip)*

### The two date-killers
**#6 Resend** and **#7 staging** both have external dependencies and neither has started, despite being week-1 tasks. Everything else is in-house build at the pace we've been hitting. **Recommendation:** build the admin surface next (#1→#2→#3 — pure in-house, backends ready, completes Acts 2 & 3 visually) *while* kicking off DNS for Resend in parallel, and spike staging early to retire the unknown. Decide the slip question against the **week-9 (~24 July) fuse**.

---

## 5. The full platform — what's left (against `requirements.md`)

The 13-week plan is a **demo slice**. `requirements.md` defines the full 24-week product. Overall build completion is **~15–20%**, concentrated in the recruitment front-half + foundation + wedge. `demo-scope-v2.md` §3 already pre-frames most of the gaps below as "deliberately not in the demo → onboarding-window or post-POC roadmap," so this is scope-accounting, not a defect list.

| `requirements.md` § | Area | Status | Built / Missing |
|---|---|---|---|
| 4 | Lifecycle state machine | 🟡 ~40% | Recruitment stages exist; onboarding/offboarding stages are labels only. |
| 5.1 | Headcount & requisition | 🟢 ~70% | Envelopes/positions/reqs/knockouts built. Missing: bulk/clone/template creation, Workday position linkage. |
| 5.2 | JD authoring | 🟡 ~40% | `jd_versions`+`jd_skills` schema. Missing: AI JD generator UI, bias scanner, multi-language, external posting. |
| 5.3 | Sourcing & intake | 🟡 ~30% | Apply + parser + dedup + ownership. Missing: job-board posting/sync, email-to-apply, referral form, talent pool, WhatsApp apply, public careers site (empty stub). |
| 5.4 | Screening | 🟢 ~65% | Real scoring + knockouts + explanation + triage. Missing: bias/fairness reports, ρ≥0.4 calibration. |
| 5.5 | Interviewing | 🔴 ~5% | **Almost nothing.** No interviews/panels/scorecards/feedback/availability tables; no calendar; no video/transcript; no feedback SLA. |
| 5.6 | Offers & pre-onboarding | 🟡 ~45% | Offers + accept + Workday-sim handoff. Missing: real e-signature, comp recommendation, PDF, negotiation log. |
| 6 | HR Partner sourcing | 🟡 ~25% | Identity/assignment/dedup/ownership **schema** (8 tables). Missing: the **partner portal** (empty stub), commercials/fees/invoicing (no `partner_fees`/`partner_msa`/invoice tables), communication guardrails + content scanner, SLA dashboards, ad-hoc email intake wiring. |
| 7 | Onboarding | 🔴 ~2% | **Zero build.** No onboarding cases, document_types, BGV, provisioning. Only the Day-0 Workday-hire moment (simulated). |
| 8 | Offboarding | 🔴 0% | **Zero.** No resignation/notice/KT/asset-return/F&F/exit-interview/alumni/Workday-terminate. |
| 9.1 | Workday integration | 🟡 ~15% | Outbox + idempotency + payload schema, but **simulator only**. No real SOAP/REST, no org/position sync, no reconciliation. |
| 9.2 | Compliance | 🟡 ~35% | Audit logs, encryption, consent capture, RLS. Missing: `pii_access_log`, fairness reports, retention/erasure automation, DPO/breach flows. |
| 9.3 | Security | 🟡 ~40% | FORCE RLS, per-tenant encryption, compound-tenant FKs. Missing: **SSO (SAML/OIDC)** — still email/password; MFA; field-level PII encryption; rate limiting; pen test. |
| 9.4 | Observability | 🟡 ~40% | pino + Sentry. Missing: product analytics, uptime, perf budgets, SIEM. |
| 9.5 | Notifications | 🟡 ~30% | Email outbox + templates + worker. Missing: **real delivery (Resend unwired)**, WhatsApp, SMS, push, in-app bell, Slack/Teams, per-persona matrix, opt-in/out. |
| 9.6 | Bulk operations | 🔴 0% | None. Single-record only. |
| 9.7 | Search | 🔴 0% | None beyond triage filters. |
| 9.8 | Reporting | 🔴 0% | None. No time-to-fill/cost-per-hire/funnel/source/attrition. |
| 9.9 / 9.10 | i18n / Mobile | 🔴 / 🟡 | No translations; apply+offer mobile-first, recruiter desktop. |

### The three unbuilt pillars (each a multi-week build)
- **Onboarding (§7):** pre-boarding (welcome, document collection with `document_types` taxonomy, BGV vendor integration, geography-specific forms), Day-0 real Workday hire, Day 1–30 (IT/SCIM provisioning, training, check-ins, probation tracking), onboarding analytics. Picks up exactly where the current Workday-hire *moment* leaves off — the natural next pillar.
- **Offboarding (§8):** resignation/termination initiation, notice-period + KT + asset return + F&F, LWD access revocation (SCIM), Workday terminate, exit interview + alumni, offboarding analytics.
- **Partner portal + commercials (§6):** the empanelled partner portal (separate auth tier, org hierarchy, req visibility, submission, pipeline tracking, communication guardrails, SLA/commercials dashboards), the fee/MSA/invoice ledger, and ad-hoc email-intake wiring. The identity/ownership schema exists; everything above it doesn't.

### Cross-cutting production layer (largely absent)
Real Workday connector (replaces simulator), real notification delivery (Resend/WhatsApp/SMS/Slack), SSO/MFA, reporting suite, full-text/faceted search, bulk operations, fairness reporting, retention/erasure automation, rate limiting, pen test.

---

## 6. Wave structure & recommended sequencing

The full build maps to the 24-week wave structure (`requirements.md` §11, `HANDOVER.md` §3.6) — schedule superseded by the 13-week demo plan, but the *scope grouping* still holds:
- **Wave 1 (thin slice + wedge):** mostly done — this is what exists today.
- **Wave 2 (volume & polish):** bulk ops, real AI scoring calibration + bias shield, WhatsApp/SMS, job-board posting, reporting suite, interviewing.
- **Wave 3 (production readiness):** real Workday, SSO, pen test, DPDPA audit, DR drills, scale to 300 hires/month.

**Recommended order once the demo is delivered:**
1. Finish the demo (§4).
2. **Onboarding pillar** — highest continuity (extends the Workday-hire moment), unblocks the "full lifecycle" claim.
3. **Real Workday connector** — replaces the simulator; onboarding needs it to be real.
4. **Partner portal + commercials** — the dominant sourcing channel for GCC; schema is ready.
5. **Offboarding pillar** — completes the lifecycle.
6. **Cross-cutting hardening** — SSO, reporting, search, bulk ops, real notification channels.

Reshape at each pillar boundary; don't plan the whole thing up front. The foundation (RLS, encryption, outbox/worker, audit, agent runtime) is strong enough that each pillar mostly *reuses* patterns rather than inventing them — that's the leverage.

---

## 7. How to work (the established rhythm)
Chat-Claude designs and writes prompts with explicit scope fences + verification gates; Claude Code executes; the user reviews critically before push. The user is terse, decisive, trusts recommendations over option-menus, and pushes back hard when something's wrong. Commit only when asked; branch off `main` first. Full working-style notes are in `docs/HANDOVER.md` §5. Per-ticket execution reports go in chat, not the repo; `HANDOVER.md` is the canonical drift/decision record (realities #1–112) and `docs/open-questions.md` is the active questions tracker.

---

## 8. Branch state
Working branch `feat/followup-01-real-executors` (verify with `git log --oneline main..HEAD`):
- `d19fed7` → `bce4a7c` — FOLLOWUP-01 arc: real draft/send executors, JSX runtime + template fixes, approval queue UI.
- `12ebfc3` — this status doc created.
- `2255707` / `9ce008f` / `1c940d7` — ADMIN-01/02/03: the three admin surfaces.
- `1e65496` — WORKER-01: stage_stale scanner.
- `0751e01` — SEED-01: demo-wedge seed (+ smoke-test order-independence hardening).
- `0e70f8f` — Act-2 demo-script rewrite.
- `ed04eff` — HYGIENE-01: stub apps deleted, shared portal nav, link audit.

Working rhythm since 11 July: the orchestrator (Fable, main session) scopes tickets and commits; an Opus executor subagent codes one ticket at a time; commits are delegated, pushes remain human-only.
