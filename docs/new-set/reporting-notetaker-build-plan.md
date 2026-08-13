# Reporting & Notetaker — assessed build plan

Date: 2026-08-12 · Source: `/public/HireOps-Reporting-Notetaker-Plan.pdf` (v0.1) assessed against the codebase at `main` (3e71669, latest migration 0112).

The PDF's thesis holds: most of the 23 reports are queries over data HireOps already captures, and the notetaker is the one net-new capture stream. But three of its assumptions don't match the codebase, and its per-report "Existing/Partial/New" ratings are wrong in five places. This doc corrects those and lays out the ticket sequence.

---

## 1. What the PDF gets right (verified)

- **Event data is rich.** `application_state_transitions` and `requisition_state_transitions` are full append-only histories with timestamps and actors. `offers` carries all four lifecycle timestamps plus `declined_reason`/`cancelled_reason`. Approvals are a complete matrix→chain→request→decision model. Onboarding (cases, tasks, documents, BGV, IT provisioning, assets) and offboarding (cases, tasks, exit interviews, asset returns, final settlements) are fully modelled. `ai_usage_logs` has cost/model/feature/tenant; agent tables cover proposed→approved→executed.
- **The tenant AI-config layer claim is accurate.** `AI_FEATURE_KEYS` (`packages/api-types/src/ai-settings.ts`) with per-feature kill-switches, model allowlist, per-tenant provider selection, envelope-encrypted BYO keys (`integration_credentials`), automatic cost logging via `recordAIUsage`, prompt-version provenance. Adding an `interview_notes` feature key follows an 11-feature precedent exactly.
- **Multi-tenant safety is by construction.** 117 RLS-enabled tables, `withTenantContext`, plus belt-and-braces explicit `tenant_id` predicates in every analytics query.

## 2. Where the PDF is wrong or optimistic

### 2.1 "Materialised views on the read replica" — no replica exists
Single Supabase Postgres; `DATABASE_URL`/`DIRECT_URL` are two pooler modes on the **same** database. Zero views or materialized views in 105 migrations. Every existing metric is raw SQL at request time (`db.execute(dsql\`...\`)` inside the tenant transaction), and at POC scale that is fine — all five existing analytics surfaces work this way. **Decision: keep request-time aggregates; skip replica/MV plumbing for the POC.** If a report gets slow, a materialized view is an additive migration later.

### 2.2 Phase 0 is ~half built already
The PDF plans reports #1–6, #10, #15, #16 as greenfield. In reality five role-gated surfaces already compute most of these KPIs:

| Existing surface | Proc (all in `apps/api/src/trpc/router.ts`) | Covers (report #) |
|---|---|---|
| `/metrics` (hr_head, admin) | `getHrMetrics` | funnel, time-in-stage, source mix, offer funnel, AI spend (#2 #4 #6 #10 #16 partial) |
| `/insights` (hiring_manager) | `getRequisitionInsights` | per-req funnel, TTH, SLA/bottlenecks, panel trends (#2 #3 #22 partial) |
| `/hr-analytics` (hr_ops) | `getHrAnalytics` | TTH by dept, drop-off, offer acceptance, demand (#3 #10 #17 partial) |
| `/admin/reports` (admin) | `getRecruitmentReport({from?,to?})` | totals, funnel, source mix, TTF median/P90, stage durations (#1–#4 #6 partial) |
| `/exec-audit`, `/admin/costs` | `getExecutiveAudit`, `getAiUsageSummary` etc. | #15 #16 #22 partial |

So Phase 0 is **consolidation + gap-fill**, not net-new: a semantic layer so these stop computing the same measures five different ways, a unified Reports surface with filters/drill/export, and the missing P0 reports (#1 req aging, #5 recruiter productivity are genuinely absent).

### 2.3 Per-report data-rating corrections

| # | PDF says | Reality |
|---|---|---|
| 7 Partner scorecard | "Existing — fees, MSA" | **Wrong.** No fee/commission/MSA/exclusivity/holdback/invoice columns anywhere. Submissions = `applications.source_partner_id`. A fee-less scorecard (submissions, shortlist rate, hires per partner) is buildable now; fees need a new commercial-terms schema. |
| 8 Cost per hire | "Partial — fees exist" | Fees do **not** exist (see #7). Blocked on the same schema. |
| 13/14 Diversity + AI fairness | "Partial — needs opt-in capture" | **Fully New.** Zero demographic fields on `candidates`/`persons`. Needs a demographics table, purpose-scoped consent, k-anonymity thresholding — a real sub-project with legal sign-off, not a "field/config". |
| 15 Compliance | "Existing — consents" | No `consents` table; consent is denormalized on `candidates` (`consent_granted_at/version`, talent-pool flags). No retention-policy table (only `document_types.retention_years`). Report is still buildable from `audit_logs` (monthly-partitioned) + `pii_access_log` + candidate columns. |
| 9 Interview health | "Existing" | Gap: `interviews` has **no `completed_at`/`cancelled_at`**. Feedback turnaround is computable (`interview_feedback.submitted_at` vs `scheduled_end`); completion timing needs a small migration. |
| 4 SLA breaches | "Existing — SLA thresholds" | Thresholds live in `tenants.settings->'slaThresholds'` jsonb with code fallbacks (`packages/sla-thresholds`), not a table. Reports must resolve jsonb-over-defaults — same pattern the worker SLA scans already use. |

Other dimension gaps: no `locations` table (free text `positions.primary_location`); dept/BU requires the `requisitions → positions → business_units` join; req `closed_at`/`filled_at` must be derived from `requisition_state_transitions`.

### 2.4 Delivery layer (export + schedule + drill) is genuinely missing — but has good bones
- Export: one client-side CSV blob (`admin/audit`); no server-side CSV/Excel/PDF, no libs installed.
- Scheduling: `apps/workers` (Fly.io) has a working interval scheduler with advisory locks (`scheduled_job_runs`) — no cron expressions. `ai-budget-scan` is the exact template for a per-tenant scheduled digest (cross-tenant service-role scan, `tenants.settings` config block, threshold dedup keys).
- Email: `notification_outbox` supports `scheduledFor` + `dedupKey`; Resend provider **already supports attachments** (used for `.ics`). No digest template yet (11 TSX templates exist to copy).
- **Recommendation: commit CSV export + scheduled email digest with CSV attachment. Defer PDF generation** (no lib, real effort, weak POC payoff) — the "board pack" can be a print-styled page.

### 2.5 Notetaker is heavier than "fast-follow" implies
Confirmed absent, each a first-of-its-kind for this codebase:
1. **No inbound webhook endpoints exist at all.** Recall.ai/ASR callbacks need a verified vendor-webhook route — the signed-link HMAC routes (`apps/api/src/routes/interviews.ts`) are the closest precedent.
2. **Storage** (`apps/api/src/lib/storage/`) has no signed-URL support and a 10MB cap mindset; audio/transcripts need both.
3. **Consent** is a one-shot apply-time checkbox. Interview-recording consent must be per-event and purpose-scoped — the candidate interview-confirm signed-link flow is the natural capture seam.
4. No calendar/video integration (fine — the Recall bot only needs `interviews.meeting_url`, which exists as free text; Teams/Zoom are explicitly `status: "deferred"` on the integrations page).

What *does* transfer cleanly: the outbox-drain worker pattern (`ai_score_outbox` + `ai-score-drain.ts` — `FOR UPDATE SKIP LOCKED`, attempt caps, orphan sweeps) for async transcript processing, and the whole AI-config/usage/provenance layer for summarisation.

---

## 3. Build plan — ticket sequence

House rules apply: one gated ticket at a time to the executor, migration numbering continues at **0113**, new surfaces use `PageContainer`, new procedures keep prompt/query logic in `apps/api/src/lib/*` (router.ts is already 1.1MB — do not grow it with inline SQL; extract report queries to `apps/api/src/lib/reports/`).

### Phase R0 — Reporting foundation (all existing data; ~1.5–2 wks)
- **R0.1 Semantic layer.** `apps/api/src/lib/reports/` (or `packages/reporting`): shared dimension resolvers (period, BU-via-positions, recruiter, source, stage, requisition) and shared measure SQL (TTF, conversion, time-in-stage via the existing `LEAD() OVER` CTE, SLA resolution jsonb-over-defaults). Canonical types in `packages/api-types`. Prove it by refactoring `getRecruitmentReport` onto it and wiring its dormant `from`/`to` filter through the UI.
- **R0.2 `/reports` surface.** Report catalog page (role-gated per report, reusing the existing double-gate pattern), standard filter bar (period, BU, requisition, recruiter, source), recharts + the established `next/dynamic` skeleton pattern.
- **R0.3 P0 reports.** #1 req status & aging (derive open-duration from `requisition_state_transitions`), #5 recruiter productivity, plus catalog entries that re-home/extend the existing funnel (#2), TTF (#3), time-in-stage/SLA (#4), source (#6), offer analytics (#10), compliance/audit (#15), AI usage (#16). Existing persona pages stay untouched.
- **R0.4 CSV export + drill-down.** Server-side CSV per report (reuse the audit-CSV cap/`truncated` contract), and KPI→row drill-down.

### Phase R1 — Sponsor & governance pack (~2 wks)
- **R1.1** #23 executive summary (extend `/exec-audit`), #17 headcount vs plan (`headcount_envelopes` is thin but sufficient), #18 approval cycle analytics, #22 SLA hot-zone (reuse worker scan queries).
- **R1.2** Migration 0113: `interviews.completed_at`/`cancelled_at` (+ set-on-status-change) → #9 interview & scorecard health; #19 onboarding readiness (BGV/provisioning/doc-collection tables are complete).
- **R1.3 Scheduled digests.** New worker job cloned from `ai-budget-scan` + a report-digest email template + `tenants.settings.reportDigests` config block; CSV attachment via the existing Resend attachment path; `dedupKey` per (tenant, report, period).
- **R1.4 Diversity + AI fairness** — **gated on a product/legal decision** (see §4). Migration for opt-in `candidate_demographics` + purpose-scoped consent + min-count (k≥5) aggregation; then #13 funnel and #14 four-fifths checks on `ai_score` pass rates.
- **R1.5 Partner scorecard.** Ship fee-less now (#7 minus fees). Fees/#8 cost-per-hire **gated on a commercial-terms schema decision** (see §4).

### Phase R2 — Notetaker integration (~2–3 wks, gated on sponsor ask)
- **N2.1 Schema + config.** Migration: `interview_recordings` (consent state, vendor refs, status), `interview_transcripts`, `interview_notes` (structured, with `model` + `prompt_version` like `interview_prep`). Add `interview_notes` to `AI_FEATURE_KEYS`/`AI_FEATURE_META` — kill-switch, model choice, BYO-key and cost logging come free.
- **N2.2 Consent + capture.** Recording consent on the candidate interview-confirm signed-link flow (disclosure copy + consent record; no consent → no bot). Vendor interface + Recall.ai adapter (bot joins `meeting_url`); first vendor-webhook route (HMAC-verified) + storage signed-URL support for audio.
- **N2.3 Summarisation pipeline.** `transcript_outbox` drain worker cloned from `ai-score-drain`: transcript → `getAIClient(tenantId).completeStructured` → structured notes on the interview round. Usage/cost/provenance automatic.
- **N2.4 Surface + feed.** Notes on the panel feedback flow and candidate drawer, feeding scorecards/feedback summaries. (Mind the deliberate "not a surveillance surface" stance in `SessionBoard.tsx` — notes assist the panellist, never auto-fill recommendations.)

### Phase R3 — Enabled reports (post-dependency)
#21 conversation intelligence (needs R2), #20 offboarding themes (NLP over `exit_interviews` — the AI-feature pattern again), #12 quality-of-hire (needs the HRMS post-hire write-back, i.e. the deferred Workday work package).

---

## 4. Decisions needed from the human before dispatch

1. **Consolidate vs coexist:** build `/reports` as the new catalog and leave the five persona pages as-is (recommended), or fold them in now?
2. **Diversity capture (R1.4):** collecting demographic data is a legal/consent decision (DPDPA vs EEOC framing differs) — needs sign-off before any schema lands.
3. **Partner commercial terms (R1.5/#8):** fee %, exclusivity, holdback need product/commercial definition before a schema is designed.
4. **PDF export:** recommend deferring; CSV + scheduled digest + print-styled board pack instead.
5. **Notetaker vendor + budget:** Recall.ai (+Deepgram) bills per-minute regardless of BYO LLM key — a real per-tenant COGS line; and Phase R2 competes with Workday integration for POC time, exactly as the PDF cautions.
