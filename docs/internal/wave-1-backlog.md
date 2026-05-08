# HireOps — Wave 1 Backlog

**Scope:** Wave 1 only — "End-to-end thin slice" weeks 1–11 per `requirements.md` §11. Goal: process one hire end-to-end through every lifecycle stage, with the partner sourcing channel functional. Volume: 10 hires across the wave, 6 via partner submission. 3 friendly empanelled vendors.
**Effort scale:** S = ≤2 days, M = 3–5 days, L = 1–2 weeks, XL = >2 weeks (flag for breakdown).
**Citations:** Every task is backed by a `file.md §section` reference.
**Out of scope (deferred):** Bulk operations, partner bulk submission, partner messaging + content scanner, partner commercials beyond read-only, full AI scoring + bias shield, WhatsApp/SMS, job-board posting, reporting suite, onboarding analytics, dispute resolution UI, invoice integration with finance, multi-language UI, mobile-native — these are Wave 2 or Wave 3 per `requirements.md` §11.

This is intentionally not exhaustive — it's the minimum to land the thin slice. Tasks marked `BLOCKED ON KYNDRYL` cannot start until the named open question is resolved (see `open-questions.md` §c).

---

## Foundations (FND) — repo, CI, observability, auth

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| FND-01 | Configure CI on GitHub Actions: lint + typecheck + unit tests + build matrix per package; PR gate (2 reviews, passing CI) | S | — | `architecture.md` §12.3, §12.4 |
| FND-02 | Wire Sentry into all 4 frontends + `apps/api` + `apps/workers`; PII scrubber on capture | S | FND-01 | `architecture.md` §12.5, §9.3 |
| FND-03 | Wire PostHog into 4 frontends; instrument apply funnel as board-level metric | S | FND-01 | `architecture.md` §12.5; `requirements.md` §9.4 |
| FND-04 | Wire Datadog APM + structured logs into `apps/api` + `apps/workers`; runbook conventions | M | FND-01 | `architecture.md` §12.5; `workday-adr.md` §5.9 |
| FND-05 | Bootstrap Storybook in `packages/ui`; CI builds the Storybook on PR | S | FND-01 | `architecture.md` §4.1 |
| FND-06 | Provision SSO bridge (SAML/OIDC → Kyndryl IdP) for `apps/internal-portal`; audience-scoped JWT `aud=internal-portal` | M | Q4 (SSO provider) — **BLOCKED ON KYNDRYL** | `architecture.md` §9.1, §7.2; `requirements.md` §12 Q4 |
| FND-07 | Set up candidate auth (Supabase Auth: email/password + magic link + phone OTP); audience-scoped JWT `aud=candidate-portal`; MFA optional | S | — | `architecture.md` §9.1 |
| FND-08 | Set up partner auth in a separate tenant (Supabase Auth or Auth0/Clerk); magic-link + mandatory MFA; 5-fail lockout; 90-day inactivity suspend | M | — | `architecture.md` §7.2; `partner-wireflows.md` §3.1 |
| FND-09 | Cloudflare WAF + per-portal rate limits (partner stricter); geo routing | S | FND-06, FND-07, FND-08 | `architecture.md` §3 (diagram), §7.2 |
| FND-10 | Secrets management: AWS Secrets Manager **or** HashiCorp Vault — picked, configured, accessible from `apps/api` + `apps/workers` + `packages/workday-client` | M | — | `architecture.md` §6.3, §9.3; `workday-adr.md` §5.3 |
| FND-11 | Provision the 5 environments (local, dev, staging, demo, prod). `enterDemo()` only present in demo build via flag | S | FND-10 | `architecture.md` §12.1, §9.1 |
| FND-12 | Pick + configure API runtime host (Fly.io picked per `architecture.md` §17 Q3 default); Dockerise `apps/api` + `apps/workers` | M | — | `architecture.md` §17 Q3, §12.2 |
| FND-13 | Lighthouse CI + bundle-size budgets per frontend bundle, in CI | S | FND-01 | `architecture.md` §12.4 |
| FND-14 | Snyk / npm audit / Dependabot turned on; baseline triage | S | FND-01 | `architecture.md` §9.5 |

## Database & schema (DB)

Per `requirements.md` §11 ("the rules can't be retrofitted later"), the candidate ownership state machine + dedup must ship in Wave 1.

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| DB-01 | Provision Postgres on Supabase managed in ap-south-1 (Mumbai) per `architecture.md` §17 Q1 + Q2 defaults | S | — | `architecture.md` §17 Q1, Q2; `requirements.md` §9.2 |
| DB-02 | Migrations framework + seed scripts inside `packages/db`; PR-gated migration discipline | M | DB-01 | `architecture.md` §12.2 |
| DB-03 | Schema: `persons`, `candidates`, `employees` (split per `architecture.md` §5.2), with FKs and lifecycle constraints | M | DB-02 | `architecture.md` §5.1, §5.2 |
| DB-04 | Schema: `requisitions`, `jobs`, `jd_versions`, `jd_skills` + req state machine | M | DB-02 | `architecture.md` §5.1; `requirements.md` §5.1 |
| DB-05 | Schema: `applications`, `interviews`, `interview_feedback`, `interview_plans`, `interview_summaries` | M | DB-03, DB-04 | `architecture.md` §5.1 |
| DB-06 | Schema: `offers`, `offer_recommendations` | S | DB-05 | `architecture.md` §5.1; `requirements.md` §5.6 |
| DB-07 | Schema: `positions`, `headcount_envelopes`, `position_assignments` | M | DB-02 | `architecture.md` §5.1; `requirements.md` §5.1 |
| DB-08 | Schema: `candidate_ownership_claims` with `UNIQUE INDEX ... WHERE status='active'` partial index — the database-level guarantee | M | DB-03 | `architecture.md` §7.4 |
| DB-09 | Schema: `candidate_dedup_attempts` (audit of every rejected submission attempt) | S | DB-03, DB-08 | `architecture.md` §7.4, §7.6 |
| DB-10 | Schema: `partner_orgs`, `partner_users`, plus `partner_invitations` and `partner_assignments` (the latter two are referenced in `partner-wireflows.md` §3.1, §3.3 but not in `architecture.md` §5.1 — see `open-questions.md` §b) | M | DB-02 | `architecture.md` §7.3, §7.4; `partner-wireflows.md` §3.1, §3.3 |
| DB-11 | Schema: `partner_msa` + `partner_fees` with `msa_snapshot` JSONB | M | DB-08, DB-10 | `architecture.md` §7.8 |
| DB-12 | Schema: `ad_hoc_partners` (registered domains, default consent text, daily quota, default fee terms) | S | DB-10 | `requirements.md` §6.5; `partner-wireflows.md` §4, §5.1 |
| DB-13 | Schema: `consents`, `data_principal_requests` | M | DB-03 | `architecture.md` §5.1, §10.1, §10.2; `requirements.md` §6.9, §9.2 |
| DB-14 | Schema: `pii_access_log` + DB triggers/instrumentation hooks for PII reads | M | DB-13 | `architecture.md` §5.1, §9.4 |
| DB-15 | Schema: extend `audit_logs` with new state-transition types (onboarding/offboarding/partner) | S | DB-02 | `architecture.md` §5.1, §9.4; `requirements.md` §4 |
| DB-16 | Schema: `workday_sync_jobs` (with `business_key` unique index for idempotency), `workday_worker_links`, `workday_position_links` | M | DB-03, DB-07 | `architecture.md` §5.1, §6.1; `workday-adr.md` §5.6 |
| DB-17 | Schema: `integration_credentials`, `integration_endpoints`, `integration_runs`, `integration_failures` (replaces Lovable's mock `integrations`) | M | DB-02 | `architecture.md` §5.1 |
| DB-18 | Schema: onboarding core — `onboarding_cases`, `onboarding_tasks`, `onboarding_documents` | M | DB-03 | `architecture.md` §5.1 |
| DB-19 | Schema: `bgv_runs`, `bgv_results` | S | DB-18 | `architecture.md` §5.1 |
| DB-20 | Schema: `it_provisioning_requests`, `asset_assignments` | S | DB-18 | `architecture.md` §5.1 |
| DB-21 | Schema: offboarding core — `offboarding_cases`, `offboarding_tasks`, `asset_returns`, `final_settlements`, `exit_interviews` | M | DB-03 | `architecture.md` §5.1 |
| DB-22 | Schema: `notifications` (extend Lovable), `notification_templates`, `notification_dispatches`, `notification_preferences` | M | DB-02 | `architecture.md` §5.1; `requirements.md` §9.5 |
| DB-23 | Schema: `data_retention_schedules` + nightly soft-delete + 30-day hard-delete job | M | DB-13 | `architecture.md` §10.3 |
| DB-24 | Schema: `approval_chains`, `approval_requests` (extend Lovable), `approval_decisions` | M | DB-02 | `architecture.md` §5.1; `requirements.md` §5.1, §5.6 |
| DB-25 | Schema: `requisition_knockouts` (referenced in `partner-wireflows.md` §3.4, §3.5; not in §5.1 — see `open-questions.md` §b) | S | DB-04 | `requirements.md` §5.4; `partner-wireflows.md` §3.4 |
| DB-26 | RLS policies — internal users (recruiter req-scoping; HM req-ownership; panel interview-scoping; HR Ops region/function; admin everywhere with PII logging) | L | DB-03..DB-08 | `architecture.md` §9.2, §5.1 |
| DB-27 | RLS policies — candidate self-only access | S | DB-03, DB-13 | `architecture.md` §7.3 (analogous policy); `requirements.md` §10.6 |
| DB-28 | RLS policies — partner org-scoping on `candidates`, `applications`, redacted `interviews`, status-only `offers`, `notifications`; default-deny on internal feedback/scoring | L | DB-08, DB-10, DB-11 | `architecture.md` §7.3 |
| DB-29 | Composite indexes per access patterns: `(requisition_id, stage, ai_score DESC)`, `(hiring_manager_id, stage)` partial WHERE not-final, `(workday_sync_status, last_sync_at)`, audit log time+actor | M | DB-04, DB-05, DB-16 | `architecture.md` §5.3 |
| DB-30 | tsvector column on `candidates` + GIN index for Postgres FTS (sufficient for Wave 1 volume) | S | DB-03 | `architecture.md` §5.1 (`search_documents`), §5.3 |
| DB-31 | PITR (30-day retention) + nightly cross-region logical backup; quarterly DR drill scheduled | S | DB-01 | `architecture.md` §5.5 |
| DB-32 | Provision Redis (BullMQ + cache) | S | FND-12 | `architecture.md` §4.2, §5.4 |

## Internal API surface (API)

Wave 1 ships the procedures the thin slice needs. Bulk operations (`requirements.md` §9.6) deferred to Wave 2.

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| API-01 | tRPC server skeleton in `apps/api`: Hono + tRPC + audience-scoped JWT verification per portal | M | FND-12 | `architecture.md` §3, §4.2, §7.2 |
| API-02 | Permission middleware: RBAC + ABAC (req-scoping, partner-scoping, candidate self-only) | M | API-01, DB-26..DB-28 | `architecture.md` §9.2, §7.3 |
| API-03 | Audit logger middleware: every state transition + every PII access logged via DB-15/DB-14 | M | API-01, DB-14, DB-15 | `architecture.md` §9.4; `requirements.md` §9.2 |
| API-04 | File upload pipeline: S3 presigned URLs + KMS-encrypted storage; ClamAV scan on uploads (esp. partner CVs) | M | FND-10 | `architecture.md` §3, §4.2, §9.3, §7.11 |
| API-05 | Requisition CRUD + state-machine endpoints (draft → pending_approval → approved → on_hold → posted → filled/cancelled/closed) | M | API-01, DB-04, DB-24 | `requirements.md` §5.1; `architecture.md` §5.1 |
| API-06 | JD generation endpoint (calls `packages/ai-client`); JD library + versioning | M | API-01, AI-01 | `requirements.md` §5.2; `architecture.md` §13 |
| API-07 | Application intake endpoint (consumed by careers site, candidate portal, and partner portal) | M | API-01, DB-05 | `requirements.md` §5.3 |
| API-08 | Resume parser worker trigger (Haiku LLM + structured JSON; OCR fallback for image scans) | M | AI-01, API-04 | `requirements.md` §5.3; `architecture.md` §13.1, §7.5 |
| API-09 | Dedup service: normalise email/phone, hash CV, atomic INSERT ... ON CONFLICT against the partial-unique index. Wave 1 — req-bound submissions only | L | DB-08, DB-09, API-08 | `architecture.md` §7.4, §7.5, §7.6; `requirements.md` §6.4 |
| API-10 | Application stage-transition endpoints: screen → shortlist → tech → HR → offer drafted → accepted | M | API-01, DB-05 | `requirements.md` §4, §5.4–§5.6 |
| API-11 | Interview scheduling (Google Calendar + Microsoft Graph two-way sync — both, per `architecture.md` §17 Q11 default) | L | API-01, FND-10 | `architecture.md` §8.3, §17 Q11; `requirements.md` §5.5 |
| API-12 | Interview feedback endpoint + 24h SLA tracking surfaced via job that stamps overdue | M | API-01, DB-05 | `requirements.md` §5.5 |
| API-13 | Offer drafting + multi-level approval endpoints | M | API-01, DB-06, DB-24 | `requirements.md` §5.6 |
| API-14 | Offer e-signature: integrate DocuSign (per `architecture.md` §17 Q10 default; Adobe Sign as alternative) | M | API-01, FND-10 | `architecture.md` §8.7, §17 Q10; `requirements.md` §5.6 |
| API-15 | Notification dispatcher (email-only via SendGrid in Wave 1; WhatsApp/SMS deferred to Wave 2) | M | API-01, DB-22 | `architecture.md` §8.5; `requirements.md` §11 (Wave 2 maps WhatsApp/SMS) |
| API-16 | AI scoring MVP: single Anthropic call per candidate, score + top-3 contributing factors stored. Bias shield + fairness reports = Wave 2 | M | AI-01, DB-05 | `requirements.md` §5.4, §11 (Wave 2 = real AI scoring + bias) |
| API-17 | DPDPA endpoints: data download, deletion request, consent withdrawal | M | API-01, DB-13 | `architecture.md` §10.2; `requirements.md` §9.2 |

## AI client (AI) — `packages/ai-client`

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| AI-01 | Implement `packages/ai-client`: provider abstraction, prompt versioning in repo, structured-output enforcement (zod), PII redaction pre-call, token budgets | M | — | `architecture.md` §13.2, §8.6 |
| AI-02 | Anthropic Claude provider (primary) + Bedrock fallback wired (Anthropic direct picked per `architecture.md` §17 Q5 default) | S | AI-01 | `architecture.md` §13.1, §17 Q5 |

## Internal portal (INT) — `apps/internal-portal`

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| INT-01 | App shell, navigation, role-aware routing, demo bypass excluded from prod build | M | FND-06 | `requirements.md` §10.8; `architecture.md` §9.1 |
| INT-02 | SSO login + session handling (audience-scoped tokens) | S | FND-06, INT-01 | `architecture.md` §9.1 |
| INT-03 | Recruiter dashboard (KPI tiles + SLA breach widget) — real React Query hooks, no mock data | M | API-01, INT-01 | `requirements.md` §10.1 |
| INT-04 | Candidates list with faceted filters + server-side pagination (replaces Lovable mock) | M | API-07, API-10, INT-01 | `requirements.md` §10.1 |
| INT-05 | Candidate detail page split into tabs (Profile / Applications / Interviews / Communications / Audit) | L | INT-04, API-12 | `requirements.md` §10.1 (refactor 417-line page) |
| INT-06 | Recruiter shortlist (score-ordered, quick-reject reasons; no bulk yet) | M | API-16, INT-04 | `requirements.md` §5.4, §10.1 |
| INT-07 | HM dashboard (open reqs + candidates needing my review) | S | API-05, API-10, INT-01 | `requirements.md` §10.2 |
| INT-08 | Create-requisition wizard (multi-step, draft saving, position-from-Workday lookup) | L | API-05, WD-08 | `requirements.md` §10.2 (628 lines refactor) |
| INT-09 | JD builder + JD library (calls API-06; LLM-powered) | M | API-06, INT-01 | `requirements.md` §10.2 |
| INT-10 | Skill-weights editor (feeds AI scoring) | S | API-05, INT-09 | `requirements.md` §10.2 |
| INT-11 | Approval tracker (multi-level workflow inbox; mobile-responsive given approver "often mobile") | M | API-05, API-13, DB-24 | `requirements.md` §3.3, §5.1, §10.2 |
| INT-12 | HR Ops cases board — recruitment cases for Wave 1; onboarding/offboarding minimal extensions ride on ONB-* / OFF-* | L | API-01, DB-18, DB-21 | `requirements.md` §10.4 |
| INT-13 | HR Ops offer drafting + approval UI | M | API-13, INT-12 | `requirements.md` §10.4 |
| INT-14 | HR Ops document collection UI (extends to BGV docs, joining docs in Wave 1 minimal flow) | M | API-04, ONB-03 | `requirements.md` §10.4 |
| INT-15 | Panel dashboard (upcoming interviews + pending feedback inbox with SLA timer) | S | API-12, INT-01 | `requirements.md` §10.5 |
| INT-16 | Panel scorecard (config-driven from `bias_rules` + role-specific rubric) | M | API-12, INT-15 | `requirements.md` §10.5 |
| INT-17 | Panel candidate brief (AI-generated; calls AI-01) | M | AI-01, INT-15 | `requirements.md` §10.5 |
| INT-18 | Admin user/role management (SSO-aware) | M | API-02, INT-01 | `requirements.md` §10.7 |
| INT-19 | Admin integrations health page (Workday status, BGV health, queue depth) | M | WD-15, INT-01 | `requirements.md` §10.7; `workday-adr.md` §5.9 |
| INT-20 | Admin audit view (DPDPA-aware, paginated, filterable) | M | DB-15, API-17, INT-01 | `requirements.md` §9.2, §10.7; `architecture.md` §10 |
| INT-21 | Admin "invite partner" flow (empanelled + ad-hoc forms) | M | DB-10, DB-12, EMI-08 | `partner-wireflows.md` §5.1 |

## Candidate portal (CND) — `apps/candidate-portal`

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| CND-01 | App shell, navigation, mobile-responsive | S | FND-07 | `requirements.md` §9.10, §10.6 |
| CND-02 | Auth (email/OTP/magic link) + session | S | FND-07, CND-01 | `architecture.md` §9.1 |
| CND-03 | Apply flow (entry from careers site or partner submission link); knockout-question handling | M | API-07, CND-01 | `requirements.md` §5.3, §5.4, §10.6 |
| CND-04 | Profile editor + DPDPA consent panel | M | API-17, CND-02 | `requirements.md` §10.6; `architecture.md` §10.1 |
| CND-05 | Applications tracker (status per req) | S | API-10, CND-04 | `requirements.md` §10.6 |
| CND-06 | Interview self-service slot picker (pulls from API-11 panel availability) | M | API-11, CND-05 | `requirements.md` §5.5 |
| CND-07 | Document upload (BGV docs, joining docs, geography-aware — see `open-questions.md` §c GCC location) | M | API-04, ONB-03 | `requirements.md` §7.1, §10.6 |
| CND-08 | Offer review + e-sign integration (uses API-14 envelope; status reflected) | M | API-14, CND-05 | `requirements.md` §5.6, §10.6 |
| CND-09 | Onboarding journey (per-hire view: tasks, documents, day-1 checklist) | M | ONB-01, CND-07 | `requirements.md` §7.1, §10.6 |
| CND-10 | Settings — DPDPA controls (data download, deletion request, consent withdrawal, language placeholder) | M | API-17, CND-02 | `requirements.md` §10.6; `architecture.md` §10.2 |

## Partner portal (PRT) — `apps/partner-portal` (empanelled tier only)

Wave 1 explicitly excludes bulk submission, speculative submissions, messaging, and full commercials per `requirements.md` §11 (those are Wave 2 / Wave 3).

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| PRT-01 | App shell, magic-link login + mandatory MFA enforcement; lockout + inactivity-suspend logic | M | FND-08 | `partner-wireflows.md` §3.1; `architecture.md` §7.2 |
| PRT-02 | Accept-invite flow (token + form + 3 attestations + MFA setup) | M | DB-10, PRT-01 | `partner-wireflows.md` §3.1 |
| PRT-03 | Partner dashboard (KPI tiles, "needs attention", activity feed; org-scoped) | M | API-02, PRT-01 | `partner-wireflows.md` §3.2 |
| PRT-04 | Open requisitions list filtered by `partner_assignments` | S | DB-10, API-05, PRT-01 | `partner-wireflows.md` §3.3 |
| PRT-05 | Requisition detail (no internal HM identity, knockouts visible, comp band visible) | M | PRT-04 | `partner-wireflows.md` §3.4 |
| PRT-06 | Single-candidate submit wizard (Step 1 CV upload → Step 2 confirm details → Step 3 consent attestation) | L | API-04, API-08, API-09, DB-13, DB-25, PRT-05 | `partner-wireflows.md` §3.5 |
| PRT-07 | Pipeline view (kanban by stage, own candidates only, status-only — no internal feedback exposed) | M | API-10, PRT-01 | `partner-wireflows.md` §3.7 |
| PRT-08 | Candidate detail (partner-scoped: timeline of stage transitions, ownership lock, fee on hire; consent record + CV downloadable; no internal feedback) | M | PRT-07 | `partner-wireflows.md` §3.8 |
| PRT-09 | Partner settings (profile, notifications, password) | S | PRT-01 | `partner-wireflows.md` §2 |
| PRT-10 | Partner-org-admin team management (invite, suspend, remove users) | M | PRT-01, DB-10 | `partner-wireflows.md` §3.12 |
| PRT-11 | Implement schema in `packages/db` per `/docs/partner-data-model.md` (most rows already covered by DB-10..DB-12; this task adds `partner_invitations`, `partner_assignments`, `partner_candidate_messages` schema + RLS policies + indexes; also `intake_attempts`, `partner_activity_log`, `ad_hoc_partner_domains`) | M | DB-10 | `/docs/partner-data-model.md` |

## Email-intake (EMI) — `apps/workers` parser + admin config

Implements the ad-hoc partner channel only. Mailbox pattern resolved: per-req aliases (`cvs-{req-id}@…`) plus `cvs-talent-pool@…`, with sender-domain attribution against `ad_hoc_partner_domains` (per `requirements.md` §6.5 and `architecture.md` §7.9 after the resolution pass).

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| EMI-01 | SES inbound + S3 routing for per-req aliases (`cvs-{req-id}@…`) and `cvs-talent-pool@…`; alias auto-generation at req posting time + auto-expire on req close | M | FND-10 | `architecture.md` §7.9; `requirements.md` §6.5; `partner-wireflows.md` §4.2 |
| EMI-02 | Email-intake parser worker: identify partner from sender domain via `ad_hoc_partners` lookup; extract subject/body for req hint or talent-pool tag | M | EMI-01, DB-12 | `architecture.md` §7.9; `partner-wireflows.md` §4 |
| EMI-03 | CV-attachment extraction (PDF/DOC/DOCX); OCR fallback for image-only scans | M | EMI-02 | `architecture.md` §7.9; `partner-wireflows.md` §4.3 |
| EMI-04 | Run resume parser → candidate record; default consent attestation pulled from partner registration when email body lacks consent language | M | EMI-03, API-08 | `partner-wireflows.md` §4.2, §5.2 |
| EMI-05 | Dedup + ad-hoc ownership claim creation: 60-day window, flat reduced fee per `partner_msa` row with `tier='ad_hoc'`, no holdback. Ad-hoc claims lose to empanelled in disputes. **BLOCKED ON KYNDRYL Q16** for the actual fee terms to seed (resolved structurally — only the values remain). | M | API-09, DB-11, EMI-04 | `requirements.md` §6.4, §6.5; `partner-wireflows.md` §4.1; `architecture.md` §7.8 |
| EMI-06 | Auto-reply with per-CV success/duplicate/unparseable summary (Section 4.2 default template, configurable in admin) | S | EMI-05 | `partner-wireflows.md` §4.2 |
| EMI-07 | "Needs human review" queue surfaced to recruiters for unparseable CVs and unknown-sender attempts | M | EMI-02, EMI-03 | `architecture.md` §7.9; `partner-wireflows.md` §4.3 |
| EMI-08 | Admin email-intake configuration (mailbox base, default consent text, parser confidence threshold, per-partner quota, BCC detection toggle) | M | INT-01, DB-12 | `partner-wireflows.md` §5.2 |

## Careers site (CRS) — `apps/careers-site`

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| CRS-01 | Next.js app scaffold using shared design tokens from `packages/ui`; SSR enabled; deployed standalone | S | FND-13 | `architecture.md` §4.1 |
| CRS-02 | Job listing pages (SSR, indexable, search). Default per `open-questions.md` §c: HireOps-hosted for POC. If Kyndryl mandates `careers.kyndryl.com` as the front, CRS-02 doubles in scope (proxy/redirect work). | M | CRS-01, API-05 | `architecture.md` §4.1; `requirements.md` §5.3, §12 Q3 |
| CRS-03 | Job detail + apply form (mobile-first, file upload, knockout questions, DPDPA consent on submit) | M | CRS-02, API-07 | `requirements.md` §5.3, §10.6 (apply UX) |
| CRS-04 | CAPTCHA + edge rate limit on apply submit | S | FND-09, CRS-03 | `requirements.md` §5.3 |
| CRS-05 | SEO basics: sitemap, structured data (`JobPosting` schema.org), OG tags | S | CRS-02 | `architecture.md` §4.1 ("SEO-critical") |

## Workday integration (WD) — per `workday-adr.md`

The longest and most fragile critical-path stretch. `requirements.md` §11 places "read org structure + positions, write Pre-Hire + Hire" in Wave 1; reconciliation hardening is Wave 3.

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| WD-01 | Sandbox tenant access provisioned (ISU + Integration System Security Group + OAuth client) — **BLOCKED ON KYNDRYL Q2**; runbook in `runbooks/workday.md` | S | — | `workday-adr.md` §5.3, §6.1; `requirements.md` §12 Q2 |
| WD-02 | Smoke-test script (`workday:smoke`) — REST `Get_Workers limit=1` + SOAP `Get_Organizations limit=1`; gate Wave 1 cutover on green | S | WD-01 | `workday-adr.md` §6.1 |
| WD-03 | OAuth 2.0 client-credentials token cache + refresh-on-expiry-window (no refresh tokens — re-fetch when within 60s of expiry) | S | WD-01 | `workday-adr.md` §1, §5.3 |
| WD-04 | SOAP client in `packages/workday-client` (handlebars-templated envelopes, WS-Security header, response parser) | L | WD-01 | `workday-adr.md` §2, §5.4 |
| WD-05 | REST + WQL client (paginated `GET`, query builder for WQL `lastModified > ?`) | M | WD-01 | `workday-adr.md` §5.1, §5.5 |
| WD-06 | BullMQ `workday` queue + `workday-sync-worker` process (multi-replica, stateless, `SELECT ... FOR UPDATE` row lock per business_key) | M | DB-16, DB-32 | `workday-adr.md` §5.2, §5.6; `architecture.md` §6.2 |
| WD-07 | Idempotency layer using `business_key` (`hire:{candidate_id}:{position_id}`, `terminate:{employee_id}:{date}`, etc.) | M | WD-06 | `workday-adr.md` §5.6 |
| WD-08 | Org snapshot read job (supervisory orgs + cost centres + locations) — nightly batch at 02:00 IST | M | WD-05, WD-06 | `workday-adr.md` §5.1 |
| WD-09 | Positions read (15-min poll using WQL `lastModified` predicate); job profiles hourly | M | WD-05, WD-08 | `workday-adr.md` §5.1 |
| WD-10 | `Put_Applicant` (Pre-Hire) on offer-accept event (or on Day 1 — **see `open-questions.md` §a contradiction #6**) | M | WD-04, WD-07 | `workday-adr.md` §5.1; `requirements.md` §7.2 |
| WD-11 | `Hire_Employee` SOAP + Business Process completion polling (60s poll, 24h SLA) + `Worker ID` write-back to `workday_worker_links` | L | WD-04, WD-07, WD-10 | `workday-adr.md` §1 (BP semantics), §5.1, §5.2 |
| WD-12 | `Terminate_Employee` + `Maintain_User_Account (Account_Disabled=true)` two-step | M | WD-04, WD-07 | `workday-adr.md` §1 (point 5), §5.1, §5.7 |
| WD-13 | Failure-mode handling (retry/backoff matrix per `workday-adr.md` §5.7, dead-letter queue, P1/P2/P3 alerts to PagerDuty) | L | WD-06 | `workday-adr.md` §5.7, §5.9 |
| WD-14 | Daily reconciliation job (forward + reverse, surfaces drift in admin dashboard) — Wave 1 ships basic; Wave 3 hardens | M | WD-08, WD-11, WD-12 | `workday-adr.md` §5.8 |

## Onboarding (ONB) — minimum viable per `requirements.md` §7

Excludes: Time-to-productivity dashboard, retention curves, NPS pulse, funnel analytics (Wave 2 onboarding analytics per `requirements.md` §11). Excludes Day-30 check-in scheduling beyond a stub.

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| ONB-01 | Onboarding case state machine (Pre-board → BGV Cleared → Document Collected → Workday Hire Sync → IT Provisioned → Day 1 Welcome → 30-Day Check-in → Probation Confirmed) | M | DB-18 | `requirements.md` §4, §7 |
| ONB-02 | Pre-board welcome flow (candidate-side: branded page, FAQ, joining-day expectations, equipment preferences) | M | CND-09 | `requirements.md` §7.1 |
| ONB-03 | Document collection — BGV docs + joining docs; geography-specific document set (India: PAN/Aadhaar/Form 11/Form F; PH: BIR 2316/SSS/PhilHealth/Pag-IBIG) — **BLOCKED ON KYNDRYL Q1 (GCC location)** | L | API-04, DB-18 | `requirements.md` §7.1, §12 Q1 |
| ONB-04 | BGV vendor integration — **BLOCKED ON KYNDRYL Q5** for vendor selection (HireRight / FirstAdvantage / AuthBridge); REST initiate + webhook receive | M | DB-19, API-04 | `requirements.md` §7.1; `architecture.md` §8.1 |
| ONB-05 | BGV webhook receiver + status update on `bgv_results` | S | ONB-04, DB-19 | `architecture.md` §8.1 |
| ONB-06 | IT provisioning queue UI + manual SCIM stub (full SCIM automation deferred). SCIM target follows Q4 SSO decision (Okta or Azure AD); manual stub for any apps without SCIM. | M | DB-20, INT-12 | `requirements.md` §7.3, §12 Q7 |
| ONB-07 | Day 1 checklist (manager + buddy confirmation + 1:1 scheduled stub) | S | ONB-01, INT-12 | `requirements.md` §7.3 |
| ONB-08 | Probation milestone tracker (default 90-day window stored on case; configurable via admin) | S | ONB-01 | `requirements.md` §7.3 |
| ONB-09 | Cross-link onboarding case → trigger Workday Pre-Hire/Hire (WD-10/WD-11) on the right state transitions | S | ONB-01, WD-10, WD-11 | `requirements.md` §7.2 |

## Offboarding (OFF) — minimum viable per `requirements.md` §8

Excludes: Exit interview LLM theme analysis, attrition cohort analytics, regrettable/non-regrettable tagging dashboards (Wave 2/3).

| ID | Description | Effort | Depends on | Source |
|---|---|---|---|---|
| OFF-01 | Resignation submission (employee self-service in candidate portal: last working day, reason drop-down + free text) | M | CND-09, DB-21 | `requirements.md` §8.1 |
| OFF-02 | Manager acknowledgement workflow (48h SLA, downstream trigger) | S | OFF-01, INT-12 | `requirements.md` §8.1 |
| OFF-03 | Offboarding case state machine (Resignation Initiated → Notice Period → Knowledge Transfer → Exit Interview → Asset Returned → Access Revoked → F&F Settled → Workday Terminate) | M | DB-21 | `requirements.md` §4, §8 |
| OFF-04 | KT plan templates + checklist | M | OFF-03, INT-12 | `requirements.md` §8.2 |
| OFF-05 | Asset return tracking (extends ONB-06 IT register) | S | DB-21, ONB-06 | `requirements.md` §8.2, §8.3 |
| OFF-06 | F&F calculation MVP (manual override permitted; full leave-encashment from Workday is post-POC) | M | DB-21, INT-12 | `requirements.md` §8.2, §8.3 |
| OFF-07 | Cross-link offboarding case → trigger Workday Terminate (WD-12) on Last Working Day Confirmed | S | OFF-03, WD-12 | `requirements.md` §8.3 |
| OFF-08 | Access revocation handoff (manual SCIM stub for POC; same blocker as ONB-06 on Q7) | S | OFF-03 | `requirements.md` §8.3 |
| OFF-09 | Exit interview MVP (form-only; analytics deferred) | M | OFF-03, CND-01 | `requirements.md` §8.3 |

---

## Backlog totals

- Foundations: 14 tasks
- Database & schema: 32 tasks
- AI client: 2 tasks
- Internal API: 17 tasks
- Internal portal: 21 tasks
- Candidate portal: 10 tasks
- Partner portal: 11 tasks
- Email-intake: 8 tasks
- Careers site: 5 tasks
- Workday integration: 14 tasks
- Onboarding: 9 tasks
- Offboarding: 9 tasks

**Total: 152 tasks.** This is over the suggested 80–120 cap. Two reasons: (1) database schema is itemised per logical group (32 rows), which the prompt's grouping of entities encourages and which is hard to compress without losing the dependency graph; (2) the partner portal in Wave 1 is intentionally non-trivial because the ownership state machine cannot be retrofitted (`requirements.md` §11 closing argument).

Tasks that could be merged to bring the count down: the DB schema rows (DB-04..DB-07 could collapse to "Recruitment core schema"; DB-18..DB-21 could collapse to "Onboarding/offboarding schema"). They are kept granular here because each one represents a distinct migration that can ship independently and unblock independent tracks. Flagging this as something to revisit if the user wants the count compressed.

---

## Critical path

The longest dependency chain through the backlog — the path that must clear before the thin slice can run end-to-end. Each step lists the chain's runtime, not the cumulative effort.

```
FND-12 (M)  →  Pick API runtime (Fly.io per arch §17 Q3 default)
   ↓
DB-01 (S)   →  Postgres provisioned on Supabase ap-south-1 (per arch §17 Q1, Q2 defaults)
   ↓
DB-02 (M)   →  Migrations framework
   ↓
DB-03 (M)   →  persons / candidates / employees split
   ↓
DB-08 (M)   →  candidate_ownership_claims (with partial-unique index)
   ↓
DB-26 / DB-28 (L)  →  RLS for internal users + partners
   ↓
API-01 (M)  →  tRPC server + JWT verification
   ↓
API-09 (L)  →  Dedup service (atomic claim insert)
   ↓
PRT-06 (L)  →  Partner single-candidate submit wizard
   ↓
API-10 (M)  →  Stage transition endpoints (so Kyndryl recruiter can move the partner-submitted candidate through screen → interview → offer)
   ↓
API-13 (M)  →  Offer drafting + multi-level approval
   ↓
API-14 (M)  →  Offer e-signature integration (DocuSign per arch §17 Q10 default)
   ↓
WD-01 (S)   →  Workday tenant access — BLOCKED ON KYNDRYL Q2
   ↓
WD-04 (L)   →  SOAP client
   ↓
WD-10 (M)   →  Pre-Hire (Put_Applicant)
   ↓
WD-11 (L)   →  Hire_Employee + BP completion polling
   ↓
ONB-01 / ONB-09 (M+S)  →  Onboarding case state machine + cross-link to Workday Hire
   ↓
ONB-03 (L)  →  Document collection — BLOCKED ON KYNDRYL Q1 (GCC location for doc set)
   ↓
ONB-04 (M)  →  BGV vendor integration — BLOCKED ON KYNDRYL Q5
```

What this tells us:
- After the resolution pass, **architecture-side blockers are all defaulted** (Q1, Q2, Q3, Q4, Q5, Q10, Q11 in `architecture.md` §17 — see `open-questions.md` §c "Resolved with defaults"). The remaining bottlenecks are all genuine Kyndryl-side decisions, principally Q2 (Workday tenant access), Q4 (SSO provider), Q5 (BGV vendor) and Q1 (GCC location).
- The **partner submit → stage transition → Workday Hire → Onboarding** chain is the one that proves the thin slice end-to-end. Every other track (recruiter UI, panel UI, careers site) supports this chain but is not on the critical path.
- The chain has approximately **5 L-effort items** stacked. With one specialist on Workday and reasonable parallelism on the partner+API side, the 11-week Wave 1 window is plausible only if blockers clear within the first two weeks.
- DB-08 (the partial-unique index on `candidate_ownership_claims`) is a small task with outsized importance — it is the database-level guarantee that makes the partner ownership state machine correct under concurrency (`architecture.md` §7.4, §7.12). It must land before any partner submission flow, and before any dedup logic. Treat as a hard gate on PRT-06 and EMI-05.
- WD-04 (the SOAP client) is the single most fragile L-task. `workday-adr.md` §4 says realistic estimate is 6 weeks for the integration specialist; that's roughly half the Wave 1 budget by itself. If Q2 slips, the whole Wave 1 timeline slips by the same margin.
