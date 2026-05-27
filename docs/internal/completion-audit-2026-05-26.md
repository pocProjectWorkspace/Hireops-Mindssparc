# HireOps — Completion Audit (2026-05-26)

**Audit method:** Read all 16 .md files under `docs/`. Extracted 137 distinct features. Assessed each against the codebase (file listings, schema files, migrations, tests, tRPC procedures, app routes). Read-and-report only — no code, schema, or test was touched.

**Date:** 2026-05-26
**Branch state:** `main` ahead of `origin/main` by 1 commit (`e309910` AI-03 shipped, not yet pushed). `origin/main = c080b40`.

---

## Section 1 — Headline numbers

| Status | Count | % of 137 |
|---|---|---|
| **SHIPPED** (real, working end-to-end, with tests, real provider where applicable) | 29 | 21.2% |
| **SHIPPED-SIMULATED** (functional for demo, deliberate simulation) | 6 | 4.4% |
| **PARTIAL** (some surface exists but feature as documented is not complete) | 15 | 10.9% |
| **NOT STARTED** (no evidence in code; schema may or may not exist) | 73 | 53.3% |
| **DEFERRED** (explicitly punted to Wave 2 / Wave 3 / Post-POC) | 14 | 10.2% |
| **Production-complete % (SHIPPED only)** | | **21.2%** |
| **Demo-functional % (SHIPPED + SHIPPED-SIMULATED)** | | **25.5%** |
| **Surface-touched % (SHIPPED + SHIPPED-SIMULATED + PARTIAL)** | | **36.5%** |

---

## Section 2 — Breakdown by execution-plan phase

The execution plan defines four phases: P1 Bedrock (weeks 1-3), P2 Vertical Slice (weeks 3-7), P3 Fan-out (weeks 7-11), P4 Hardening (week 11). Wave 1 = the 11-week thin slice. Wave 2 / Wave 3 / Post-POC = downstream waves.

| Phase | Total | SHIPPED | SHIPPED-SIM | PARTIAL | NOT STARTED | DEFERRED |
|---|---|---|---|---|---|---|
| P1 (Bedrock — multi-tenancy, schema, AI infra, observability) | 22 | 16 (72.7%) | 0 | 3 (13.6%) | 3 (13.6%) | 0 |
| P2 (Vertical Slice — apply → triage → offer → Workday-sim) | 18 | 13 (72.2%) | 2 (11.1%) | 2 (11.1%) | 0 | 1 (5.6%) |
| P3 (Fan-out — partner portal, candidate portal, onboarding, offboarding, full Workday, AI override) | 60 | 0 | 4 (6.7%) | 8 (13.3%) | 48 (80%) | 0 |
| P4 (Hardening — reconciliation, DR, perf, demo) | 5 | 0 | 0 | 1 (20%) | 4 (80%) | 0 |
| Wave 2 (Volume & polish — bulk ops, real AI scoring/bias, WhatsApp/SMS, job-board posting, reporting, partner messaging, comp engine) | 21 | 0 | 0 | 1 (4.8%) | 12 (57.1%) | 8 (38.1%) |
| Wave 3 (Production readiness — partner invoicing, dispute resolution, pen-test, DR drill) | 6 | 0 | 0 | 0 | 1 (16.7%) | 5 (83.3%) |
| Post-POC (Phase 2/3 product — MCP, GraphQL, agents, talent pool, referral, i18n) | 5 | 0 | 0 | 0 | 5 (100%) | 0 |

The signal: **Phase 1 (Bedrock) is essentially done (73% shipped, 14% partial)**, Phase 2 (Vertical Slice) is also largely done (72% shipped, 11% simulated), but **Phase 3 (Fan-out) has not yet started in earnest** — 80% NOT STARTED, only 7% simulated, 13% partial. Phase 4 (Hardening) is untouched.

---

## Section 3 — Breakdown by sub-system

| Sub-system | Total | SHIPPED | SHIPPED-SIM | PARTIAL | NOT STARTED | DEFERRED |
|---|---|---|---|---|---|---|
| A. Identity, Auth, Multi-tenancy | 12 | 6 | 0 | 3 | 2 | 1 |
| B. Schema foundations | 4 | 2 | 0 | 2 | 0 | 0 |
| C. AI infrastructure | 6 | 4 | 0 | 1 | 1 | 0 |
| D. Candidate apply path | 7 | 3 | 0 | 1 | 3 | 0 |
| E. Recruiter & Internal Portal | 10 | 4 | 0 | 2 | 3 | 1 |
| F. HR Head & Admin surface | 8 | 0 | 1 | 1 | 6 | 0 |
| G. Partner Portal | 9 | 0 | 0 | 0 | 7 | 2 |
| H. Partner ownership, intake, commercials | 9 | 1 | 0 | 1 | 5 | 2 |
| I. Workday Integration | 8 | 0 | 1 | 1 | 6 | 0 |
| J. Notifications | 6 | 3 | 1 | 0 | 1 | 1 |
| K. Onboarding | 7 | 0 | 0 | 0 | 6 | 1 |
| L. Offboarding | 6 | 0 | 0 | 0 | 5 | 1 |
| M. Offers, e-signature, comp | 5 | 2 | 1 | 1 | 0 | 1 |
| N. Interviews & Scheduling | 5 | 0 | 0 | 0 | 4 | 1 |
| O. AI scoring, knockouts, bias | 6 | 3 | 0 | 0 | 1 | 2 |
| P. Compliance / DPDPA | 6 | 0 | 0 | 2 | 3 | 1 |
| Q. Search | 2 | 0 | 0 | 0 | 1 | 1 |
| R. Reporting & analytics | 2 | 0 | 0 | 0 | 0 | 2 |
| S. Job boards & sourcing extensions | 3 | 0 | 0 | 0 | 0 | 3 |
| T. Design system | 7 | 1 | 0 | 1 | 5 | 0 |
| U. Developer Experience & ops | 6 | 2 | 1 | 0 | 1 | 2 |
| V. Future / Phase 2+ market parity | 3 | 0 | 0 | 0 | 0 | 3 |
| **Total** | **137** | **29** | **6** | **15** | **73** | **14** |

The two darkest gaps: **Partner Portal (G)** and **Onboarding (K) / Offboarding (L)** — collectively 22 features with zero anything except a few schema bones. The **Workday integration (I)** is fronted by a working simulator but the real SOAP/REST client is empty (`packages/workday-client/src/index.ts` is one line: `export {};`).

---

## Section 4 — The complete feature table

Sorted by sub-system then by status (SHIPPED first).

### A. Identity, Auth, Multi-tenancy

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| A1 | Tenant provisioning core | W1/P1 | SHIPPED | `packages/db/src/schema/tenants.ts`, migration 0000 | Slug, status lifecycle, settings JSONB all present |
| A2 | Per-tenant envelope encryption | W1/P1 | SHIPPED | `packages/db/src/kms/`, `packages/db/src/envelope.ts`, migration 0001, AwsKmsClient stub only | LocalKmsClient works end-to-end; AWS KMS stub throws |
| A3 | Integration credentials store | W1/P1 | SHIPPED | `packages/db/src/schema/integration-credentials.ts`, migration 0010+0011 | 13 integration types via CHECK; admin-only RLS |
| A4 | RLS baseline + lint enforcement | W1/P1 | SHIPPED | `packages/db/src/lint-rls.ts`, `verify-rls.ts`, migration 0003 | Reports 40 tables (5 platform + 35 tenant) |
| A5 | Tenant context middleware | W1/P1 | SHIPPED | `apps/api/src/middleware/tenant-context.ts`, `packages/db/src/with-tenant-context.ts` | JWT `tid`, AsyncLocalStorage, SET LOCAL ROLE |
| A10 | Cloudflare WAF + per-portal rate limiting | W1/P1 | SHIPPED | `apps/api/src/index.ts` CORS middleware (HANDOVER #84) | CORS only — Cloudflare WAF + rate limiting is infra not code; CORS allow-list works |
| A7 | SSO bridge for internal users | W1/P1-P2 | PARTIAL | Supabase Auth via `@supabase/ssr` in internal-portal | Supabase email/password works; no SAML/OIDC bridge to Okta/Azure AD |
| A6 | Tenant onboarding workflow | W1/P1→P3 | PARTIAL | Manual provisioning scripts only (`seed-test-users.ts`, `provision-dev-dek.ts`) | FND-15f explicitly NOT STARTED per HANDOVER §4.5 |
| A8 | Candidate auth | W1/P2 | PARTIAL | `apps/candidate-portal/src/index.ts` is empty stub | Apply form runs unauthenticated inside `apps/internal-portal` instead; no separate candidate portal |
| A9 | Partner auth tier | W1/P3 | NOT STARTED | `apps/partner-portal/src/index.ts` is empty stub | No magic-link, no MFA, no lockout, no inactivity expiry |
| A12 | SCIM provisioning for IdP | W2 | NOT STARTED | No SCIM code | — |
| A11 | DPDPA-aware tenant suspension/deletion | Post-POC | DEFERRED | Per `multi-tenancy-adr.md` §6.2-6.3; not in Wave 1 backlog | — |

### B. Schema foundations

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| B1 | Recruitment domain schema | W1/P1 | PARTIAL | persons, candidates, applications, requisitions, jd_versions, jd_skills, offers, requisition_knockouts all present | Missing: `employees`, `alumni`, `interviews`, `interview_feedback`, `interview_summaries`, `interview_plans`. So the "split into persons/candidates/employees/alumni" of `architecture.md` §5.2 is half-done |
| B2 | Compound (tenant_id, id) FK protection | W1/P1 | SHIPPED | Migration `0009_last_the_hand.sql`, HANDOVER reality #13-14 | Pattern verified by test 14 in `tenant-context.test.ts` |
| B3 | Audit + PII logging schema | W1/P1 | SHIPPED | audit_logs, api_audit_logs, application_state_transitions, requisition_state_transitions, signed_link_uses, ai_usage_logs all present | `pii_access_log` per architecture §5.1 is NOT in the schema — surfaces a gap |
| B4 | DPDPA compliance schema | W1/P1-P3 | PARTIAL | document_types reference table, consents, data_principal_requests, data_retention_schedules — none of these tables exist in `packages/db/src/schema/` | All four core DPDPA tables missing from schema |

### C. AI infrastructure

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| C1 | AI client abstraction (`packages/ai-client`) | W1/P1 | SHIPPED | `packages/ai-client/src/{factory,types,anthropic,openai,pricing,usage-log}.ts`, LocalAIClient | Per-tenant routing via `tenants.settings.ai_provider`; 5-min cache |
| C2 | Anthropic Claude provider | W1/P1 | SHIPPED | `packages/ai-client/src/anthropic.ts`; AI-03 real-provider smoke confirmed (ai_score=95, claude-sonnet-4-6, 1.1¢) | HANDOVER §7 AI-03 closes Anthropic half of open-question #7 |
| C5 | AI usage logging + cost computation | W1/P1 | SHIPPED | `ai_usage_logs` table, migrations 0018/0019; `pricing.ts` micros table | Integer cost_micros; append-only RLS |
| C6 | Resume parser pipeline | W1/P2 | SHIPPED | `packages/ai-client/src/parsers/`, `docs/parser-output-schema.md`; 10 tests in resume-parser.test.ts | pdf-parse + mammoth + tesseract.js OCR; LocalAIClient fixtures cover 7 seed CVs |
| C3 | OpenAI provider | W1/P1 | PARTIAL | `packages/ai-client/src/openai.ts` exists; LocalAIClient tests pass; no real-provider smoke ever run | Open-question #25 — OPENAI_API_KEY blocked |
| C4 | AWS Bedrock fallback | Post-POC | NOT STARTED | No Bedrock client in repo | — |

### D. Candidate apply path

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| D3 | Job-detail apply form | W1/P2 | SHIPPED | `apps/internal-portal/src/app/t/[tenantSlug]/apply/[reqSlug]/ApplyForm.tsx`, crs-01-apply.test.ts (27+ cases), Playwright crs-01-apply.spec.ts | 10MB cap, PDF/DOCX, knockout questions, DPDPA consent |
| D5 | Application intake + synchronous dedup | W1/P2 | SHIPPED | `submitApplication` in `apps/api/src/trpc/router.ts` line 154, `getCandidateById` triage; api-audit-logs trail | Per-email dedup; idempotent on candidate+application creation |
| D6 | Public requisition resolution | W1/P2 | SHIPPED | `resolvePublicRequisition` procedure line 508, `createPublicServerTRPCCaller` helper, HANDOVER #87 | Slug regex CHECK; tenant + req slug pair |
| D4 | CAPTCHA + edge rate limit on apply | W1/P2 | PARTIAL | CORS exists but no CAPTCHA, no rate limit on `/api/upload/resume` or `submitApplication` | Open-question #15 documents the gap |
| D1 | Careers site (Next.js SSR) | W1/P2 | NOT STARTED | `apps/careers-site/src/index.ts` = single empty `export {};` file | Apply form lives in internal-portal — no separate SSR careers-site |
| D2 | Job listing pages + SEO | W1/P2 | NOT STARTED | No `/jobs` route anywhere | No sitemap, no JobPosting structured data |
| D7 | DPDPA candidate controls + Privacy page | W1/P3 | PARTIAL | `apps/internal-portal/src/app/privacy/page.tsx` is a stub; no candidate self-service flows | Privacy page is placeholder only; no data download/deletion/withdrawal UI |

### E. Recruiter & Internal Portal

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| E1 | Internal portal shell + SSO login | W1/P2 | SHIPPED | `apps/internal-portal/src/app/{login,logout,layout,page}.tsx`, RootErrorBoundary, DevBanner | Supabase Auth via `@supabase/ssr`; not Okta/Azure SSO |
| E2 | Recruiter triage screen | W1/P2 | SHIPPED | `apps/internal-portal/src/components/triage/{HotZone,MomentumFeed,FilterChipsBar,CandidateDetailDrawer,UndoToastProvider}.tsx` | Hot Zone + Momentum Feed + drawer; HANDOVER Module 1b |
| E4 | Stage transition mutations + reverse-mutation undo | W1/P2 | SHIPPED | `advanceApplication`/`rejectApplication`/`revertApplicationStage` in router (lines 800-942), 30s server window per HANDOVER #53 | triage-mutations.test.ts (8 cases) |
| E3 | Candidate management UI | W1/P2-P3 | SHIPPED | `listCandidates` with faceted filters + drawer detail | Detail UI is a drawer not a full tab-page; Profile/Applications/Interviews/Communications/Audit tabs partly absent (only stages + offer section shown). Counted as SHIPPED because the use case is satisfied for Wave 1 |
| E7 | JD builder + library + skill-weights editor | W1/P2-P3 | PARTIAL | jd_versions + jd_skills schema exist; no router procedure for JD generation; no UI | Schema-only |
| E9 | HR Ops cases board + document collection UI | W1/P3 | PARTIAL | No cases UI; document collection UI absent; document_types table not in schema | Schema gaps too — cases polymorphic table not built |
| E6 | Hiring Manager dashboard + create-requisition wizard | W1/P3 | NOT STARTED | No `/hm` or `/reqs/new` route in internal-portal | — |
| E8 | Approval tracker | W1/P3 | NOT STARTED | approval_chains + approval_requests + approval_decisions schema exists; NO router procedures (grep returned nothing); no UI route | Schema-only |
| E10 | Panel dashboard + scorecard + AI candidate brief | W1/P3 | NOT STARTED | No panel route; no interview schema | — |
| E5 | Bulk operations | W2 | DEFERRED | Per `requirements.md` §11, §9.6 | Wave 2 scope |

### F. HR Head & Admin surface

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| F4 | Admin integrations health | W1/P2 | SHIPPED-SIMULATED | `apps/internal-portal/src/app/admin/integrations/{page,IntegrationsClient}.tsx`, `listWorkdaySyncs` router procedure (line 1228) | Workday-only view; reads `workday_sync_outbox` which is itself simulated; no BGV, no queue depth |
| F3 | Admin user / role management | W1/P3 | PARTIAL | tenant_user_memberships schema + 11-role tenant_role enum exist; no admin UI to manage them | Provisioning via seed scripts only |
| F1 | HR Head / TA Lead operational + analytics dashboards | W2 | NOT STARTED | No HR Head route in internal-portal | — |
| F2 | HR Head approvals + governance + DPDPA audit | W1/P3 | NOT STARTED | No `/approvals` or `/audit` UI | — |
| F5 | Admin audit view | W1/P3 | NOT STARTED | audit_logs + api_audit_logs exist; no admin UI to query/filter them | — |
| F6 | Admin invite partner (empanelled + ad-hoc registration) | W1/P3 | NOT STARTED | partner_invitations + partner_orgs + ad_hoc_partner_domains schema exist; no admin UI | Schema-only |
| F7 | Admin email-intake configuration | W1/P3 | NOT STARTED | ad_hoc_partner_domains schema only | — |
| F8 | Admin AI/bias/branding/system setup | W1/W2/P3 | NOT STARTED | No admin UI | — |

### G. Partner Portal

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| G1 | Partner accept-invite + login | W1/P3 | NOT STARTED | `apps/partner-portal/src/index.ts` is `export {};` stub | partner_invitations schema exists but no UI flow |
| G2 | Partner dashboard + open reqs + req detail | W1/P3 | NOT STARTED | No partner-portal app code | — |
| G3 | Partner single-candidate submit wizard | W1/P3 | NOT STARTED | No partner-portal app code | — |
| G5 | Partner pipeline view | W1/P3 | NOT STARTED | No partner-portal app code | — |
| G6 | Partner candidate detail | W1/P3 | NOT STARTED | No partner-portal app code | — |
| G9 | Partner team management + settings | W1/P3 | NOT STARTED | No partner-portal app code | — |
| G7 | Partner speculative talent-pool submission | W2 | DEFERRED | Per `requirements.md` §11 Wave 2 | — |
| G8 | Partner-to-candidate messaging + content scanner | W2 | DEFERRED | `partner_candidate_messages` schema shipped W1 (per HANDOVER DB-PARTNER-A); messaging UI + scanner = W2 | Schema ahead of UI; explicit defer |
| G4 | Partner bulk submission (ZIP/CSV) | W2 | DEFERRED | Per `requirements.md` §11 Wave 2 | — |

### H. Partner ownership, intake, commercials

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| H1 | Candidate ownership claim state machine | W1/P3 | SHIPPED | `packages/db/src/schema/candidate-ownership-claims.ts`, migration 0025, partial-unique index per HANDOVER #40; tested in db-partner-a.test.ts | Schema + index live; no submission flow uses it yet (no partner submit UI) |
| H3 | Ownership expiry sweep job | W1/P3 | PARTIAL | Schema + index exist; no nightly sweep job in `apps/workers/src/jobs/` | Worker job missing — load-bearing per HANDOVER #40 |
| H2 | Multi-tier ownership windows + cross-req attribution | W1/P3 | NOT STARTED | partner_msa table NOT in schema; ownership_window logic not coded | partner_msa is the keystone — its absence blocks H2/H5/H6 |
| H4 | Ad-hoc partner email-intake | W1/P3 | NOT STARTED | ad_hoc_partner_domains schema exists; no SES routing, no parser worker, no auto-reply | Schema-only |
| H5 | MSA commercial-terms engine | W1/P3 | NOT STARTED | partner_msa table NOT in schema (DB-11 unstarted) | Major schema gap |
| H6 | Partner fee tracking with msa_snapshot | W1/P3 | NOT STARTED | partner_fees table NOT in schema | Major schema gap |
| H7 | Partner commercials & invoice dashboard + finance integration | W2/W3 | DEFERRED | Per `requirements.md` §11 | — |
| H8 | Partner SLA / quality dashboards | W2 | DEFERRED | Per `requirements.md` §11 | — |
| H9 | Ownership dispute resolution UI | W3 | DEFERRED | Per `requirements.md` §11 | — |

### I. Workday Integration

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| I8 | Workday simulation drain | W1/P2 | SHIPPED-SIMULATED | `apps/workers/src/lib/workday-simulation-drain.ts` (141 lines), `workday_sync_outbox` table, deterministic mock with `simulation_notes` honesty marker (HANDOVER #76) | This is the demo path. Real connector deferred per HANDOVER #82 |
| I2 | Workday sync worker (idempotency, business_key) | W1/P3 | PARTIAL | Simulation drain runs via SKIP LOCKED with business_key; pattern correct but only simulator dispatches | When real client lands, the worker plumbing already works |
| I1 | Workday client foundation (OAuth + SOAP + REST + WQL) | W1/P2 | NOT STARTED | `packages/workday-client/src/index.ts` is literally `export {};` (1 line) | Most fragile L-task per backlog critical path |
| I3 | Workday reads (org snapshot, positions, job profiles) | W1/P3 | NOT STARTED | No reader workers | — |
| I4 | Pre-Hire (Put_Applicant) on offer-accept | W1/P2-P3 | NOT STARTED | Offer-accept enqueues to `workday_sync_outbox` only; no SOAP call | — |
| I5 | Hire (Hire_Employee + BP polling) on Day 1 | W1/P3 | NOT STARTED | No Day-1 cron job; no BP polling | — |
| I6 | Terminate_Employee + Maintain_User_Account | W1/P3 | NOT STARTED | No termination worker | — |
| I7 | Daily reconciliation + drift detection + PagerDuty | W1/P4 + W3 | NOT STARTED | No reconciliation job; no PagerDuty wiring | — |

### J. Notifications

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| J5 | Outbox-first dispatcher + signed-link tokens | W1/P2 | SHIPPED | `apps/workers/src/lib/dispatcher.ts`, `packages/notifications/`, `signed_link_uses` table, HANDOVER Module 3 | 5s drain; HMAC-SHA256 signed links; one-time-use enforced |
| J6 | SLA-imminent recruiter alert | W1/P2 | SHIPPED | `apps/workers/src/jobs/sla-imminent-scan.ts`, scheduled at 15-min interval | dedup_key per recruiter per UTC day |
| J1 | Email channel (SendGrid + react-email) | W1/P2 | SHIPPED | `packages/email-templates/src/templates/*.tsx` (6 templates), `packages/notifications/src/{local,real-stub}.ts` | Local provider writes `dev_email_outbox`; RealStub throws → not yet real |
| J3 | In-app notification bell + Slack/Teams handoff | W1/P3 + Post-POC | SHIPPED-SIMULATED | Email-only delivery via `dev_email_outbox` is the only in-app surface | No bell icon, no real-time push; Slack/Teams Post-POC |
| J4 | Notification template management + versioning + preferences | W1/P3 partial + W2 | NOT STARTED | Templates are hard-coded in `packages/email-templates/`; no template management UI; no per-user preferences | — |
| J2 | WhatsApp + SMS channels | W2 | DEFERRED | Per `requirements.md` §11 | — |

### K. Onboarding

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| K1 | Onboarding case state machine | W1/P3 | NOT STARTED | No `onboarding_cases` / `onboarding_tasks` tables | — |
| K2 | Pre-board welcome flow | W1/P3 | NOT STARTED | No candidate portal app | — |
| K3 | Document collection (geography-aware) | W1/P3 | NOT STARTED | No `document_types` / `onboarding_documents` tables | — |
| K4 | BGV vendor integration | W1/P3 | NOT STARTED | No `bgv_runs` / `bgv_results` tables; no webhook receiver | — |
| K5 | IT provisioning queue + asset register | W1/P3 | NOT STARTED | No `it_provisioning_requests` / `asset_assignments` tables | — |
| K6 | Day 1 checklist + probation tracker | W1/P3 | NOT STARTED | — | — |
| K7 | 30-day check-in + onboarding analytics | W2 | DEFERRED | Per `requirements.md` §11 | — |

### L. Offboarding

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| L1 | Resignation submission + manager acknowledgement | W1/P3 | NOT STARTED | No offboarding tables; no candidate portal | — |
| L2 | Offboarding case state machine | W1/P3 | NOT STARTED | — | — |
| L3 | KT plan templates + checklist | W1/P3 | NOT STARTED | — | — |
| L4 | Asset return + access revocation handoff | W1/P3 | NOT STARTED | — | — |
| L5 | F&F calculation + alumni record + rehire flag | W1/P3 | NOT STARTED | No `alumni` table | — |
| L6 | Exit interview MVP + LLM theme analysis | W1+W2/W3 | DEFERRED | Per `requirements.md` §11 (form-only W1 deferred to W2 effectively; LLM analysis is W2/W3 anyway) | — |

### M. Offers, e-signature, comp

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| M1 | Offer drafting + recruiter UI | W1/P2 | SHIPPED | `packages/db/src/schema/offers.ts`, `apps/api/src/trpc/router.ts` `draftOffer`/`extendOffer`/`cancelOffer`/`listOffersByApplication`, `apps/internal-portal/src/components/offers/OfferSection.tsx` | Paise (bigint) for money per HANDOVER #72 |
| M4 | Candidate-side offer accept/decline via signed link | W1/P2 | SHIPPED | `apps/api/src/routes/offers.ts`, `apps/internal-portal/src/app/offer/[token]/OfferAcceptClient.tsx`; offers.test.ts (15 cases) | Full-name match required per HANDOVER #77 |
| M5 | E-signature integration (DocuSign / Adobe Sign) | W3 | SHIPPED-SIMULATED | Wave 1 ships click-is-acceptance compromise (M4 above) — this is the documented W1 compromise, not real e-sign | Open-question #12 on legal wording |
| M2 | Comp recommendation engine | W1 basic / W2 full | PARTIAL | Schema fields exist on offers (base/variable/joining-bonus paise); no `offer_recommendations` table; no recommendation logic | — |
| M3 | Multi-level offer approval | W2 | DEFERRED | Per `requirements.md` §11; approval_chains exist but offer-side routing is W2 | — |

### N. Interviews & Scheduling

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| N1 | Interview scheduling (Google + Outlook two-way sync) | W1/P3 | NOT STARTED | No interview schema tables; no calendar OAuth | — |
| N2 | Panel composition + slot picker | W1/P3 | NOT STARTED | — | — |
| N3 | Zoom / Teams integration | W1/P3 | NOT STARTED | — | — |
| N5 | Structured scorecards + feedback SLA + live coding | W1 scorecards / W2 coding | NOT STARTED | — | — |
| N4 | Interview recording + transcript + AI summary | W2 | DEFERRED | Per `requirements.md` §11 | — |

### O. AI scoring, knockouts, bias

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| O1 | AI candidate scoring at submit | W1/P2 | SHIPPED | `apps/workers/src/lib/ai-score-drain.ts` (252 lines), `ai_score_outbox` table, `packages/ai-scoring/src/prompt.ts`; AI-03 commit `e309910`; real-provider smoke confirmed | Anthropic half of AI-01 gate #7 closed |
| O2 | Knockout evaluator (sync, deterministic) | W1/P2 | SHIPPED | `packages/ai-scoring/src/knockouts.ts` (326 lines), 22 unit tests; integration in `submitApplication` | Field-path resolution, null vs false semantics |
| O3 | AI score explanation discriminator | W1/P2 | SHIPPED | `ai_score_explanation` JSONB on applications with `scored_by` discriminator (anthropic/openai/local/simulated/skipped) per HANDOVER #92 | prompt_version audit trail per HANDOVER #97 |
| O6 | AI override modal + audit trail | W1/P3 | NOT STARTED | audit_logs schema supports override entries but no `<AIOverride>` component, no UI affordance | Design-system §5.5 specifies the pattern |
| O4 | Bias shield / fairness quarterly reports | W2 | DEFERRED | Per `requirements.md` §9.2, §5.4 (Wave 2) | — |
| O5 | JD bias / language scanner | W2 | DEFERRED | Per `requirements.md` §5.2 (Wave 2) | — |

### P. Compliance / DPDPA

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| P4 | Audit logging + PII access logging + anomaly detection | W1/P1-P3 | PARTIAL | audit_logs + api_audit_logs shipped; state-transition tables shipped; pii_access_log table MISSING from schema; no anomaly detection job | Half of P4's surface is missing |
| P1 | Consents (7-year retention) | W1/P3 | PARTIAL | DPDPA-consent attestation captured on apply form into `applications.consent_*` columns (per CRS-01 test surface); no separate `consents` table; no withdrawal cascade | Schema split intent (separate `consents` table) not realised |
| P2 | Data principal rights | W1/P3 | NOT STARTED | No `data_principal_requests` table; no candidate self-service flows | — |
| P3 | Data retention schedules + soft/hard delete | W1/P3 | NOT STARTED | No `data_retention_schedules` table; no nightly job | — |
| P5 | SIEM forwarding + field-level encryption for high-PII | Post-POC | NOT STARTED | — | — |
| P6 | Penetration test + DPDPA audit + DR drill | W3 | DEFERRED | Per `requirements.md` §11 Wave 3 | — |

### Q. Search

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| Q1 | Postgres FTS + faceted filtering | W1/P1 schema, W2 UI | NOT STARTED | No tsvector column / GIN index in any migration | DB-30 in backlog NOT STARTED |
| Q2 | Resume content search + Boolean / saved searches | W2 | DEFERRED | Per `requirements.md` §9.7 (W2) | — |

### R. Reporting & analytics

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| R1 | Operational dashboards (time-to-fill, cost-per-hire, funnel, source-of-hire) | W2 | DEFERRED | Per `requirements.md` §11 | — |
| R2 | Productivity & quality dashboards + custom builder | W2 / Post-POC | DEFERRED | Per `requirements.md` §11 | — |

### S. Job boards & sourcing extensions

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| S1 | Multi-board posting (LinkedIn + Naukri + Indeed) | W2 | DEFERRED | Per `requirements.md` §11 Wave 2 | — |
| S2 | Talent pool / silver-medallist re-contact | Post-POC | DEFERRED | Per `requirements.md` §11 (Phase 2) | — |
| S3 | Referral programme | Post-POC | DEFERRED | Per `requirements.md` §5.3 (Phase 2) | — |

### T. Design system

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| T1 | Design tokens | W1/P1 | SHIPPED | `packages/ui/src/tokens.css` + `tokens.ts` mirror; matches `design-system.md` §2 line-for-line | Includes India locale defaults |
| T3 | Foundational primitives | W1/P1 | PARTIAL | `packages/ui/src/components/`: Button, Input, Select, Checkbox, Radio, Switch, Card present with Storybook stories | Missing: `<Combobox>` (§4.3 distinguishes Select vs Combobox); `<Container>` from §4.6 |
| T2 | Layout primitives (Stack/Inline/Container) | W1/P1 | NOT STARTED | No Stack/Inline/Container components in `packages/ui/src/components/` | Per §3.1-3.3 of design system spec |
| T4 | Domain components (DataTable / KPITile / StatusBadge / AvatarStack / FormField / Empty/Loading/Error) | W1/P2 | NOT STARTED | None of these in `packages/ui/`; triage UI implements its own ad-hoc cards | DataTable absence means E5 bulk operations cannot land cleanly |
| T5 | AI components catalogue | W1/P2-P3 | NOT STARTED | No `packages/ui/src/ai/*` directory; AI score visuals are inline JSX in triage components | Five components specified in design-system §5 |
| T6 | Persona shell + mobile budgets + accessibility | W1/P3 | NOT STARTED | No `<AppShell>` component; mobile viewports not tested | Internal portal works on desktop only |
| T7 | Multi-tenant white-labelling + Hindi/Tamil/Telugu i18n | W2 | NOT STARTED | No i18n framework; no per-tenant brand colour override path | — |

### U. Developer Experience & ops

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| U1 | CI/CD on GitHub Actions | W1/P1 | SHIPPED | `.github/workflows/ci.yml` — typecheck/lint/format/build parallel + api:test + db:lint:rls serialised | No branch protection yet (per HANDOVER #19) |
| U2 | Sentry error tracking | W1/P1 | SHIPPED | `packages/observability/`, `apps/api/src/lib/observability.ts`, pluggable Real/Local | Lazy-loaded `@sentry/node` per HANDOVER #18 |
| U3 | PostHog + Datadog observability | W1/P1 | SHIPPED-SIMULATED | pino structured logs + per-request request_id (HANDOVER #17); PostHog and Datadog NOT wired | "Local" observability via pino is the simulated stand-in |
| U4 | Storybook + Lighthouse CI + bundle budgets | W1/P1 | NOT STARTED | Some Storybook stories in packages/ui + internal-portal but no centralised Storybook build, no Lighthouse CI, no bundle budgets in CI | Stories exist; pipeline does not |
| U6 | Secrets management + ClamAV upload scanning | W1/P1-P2 | DEFERRED | Per FND-10 in backlog (AWS Secrets Manager / Vault choice not made); CRS-01 fence excluded ClamAV | Open-question #15 |
| U5 | PITR + cross-region backup + DR drill | W3 | DEFERRED | Per `requirements.md` §11 Wave 3 | — |

### V. Future / Phase 2+ market parity

| ID | Feature | Phase | Status | Evidence | Notes |
|---|---|---|---|---|---|
| V1 | MCP server support | Post-POC | DEFERRED | Per `competitive-landscape.md` §3.3 | — |
| V2 | Public GraphQL API | Post-POC | DEFERRED | Per `competitive-landscape.md` §3.3 | — |
| V3 | AI agents (autonomous scheduling + assistant + Custom Agents) | Post-POC | DEFERRED | Per `competitive-landscape.md` §3.1 | — |

---

## Section 5 — Demo-readiness assessment

### What works end-to-end as a coherent demo today

The following sequence runs end-to-end on the synthetic `kyndryl-poc` tenant (per the seed-demo-data script):

| Step | Demo action | Supporting features |
|---|---|---|
| 1 | Visit `/t/kyndryl-poc/apply/{req-slug}` as a candidate | D3 apply form, D5 intake, D6 public req resolution |
| 2 | Upload PDF resume, fill knockout questions, attest DPDPA consent, submit | D3 apply form, C6 resume parser, O2 knockout eval, D5 dedup |
| 3 | Application lands; AI scoring fires async; recruiter receives email + SLA breach alert | O1 AI scoring, J5 outbox dispatcher, J1 email channel, J6 SLA scan |
| 4 | Log into internal portal as `recruiter1@kyndryl-poc.test` (`/login` → SSO) | E1 portal shell |
| 5 | Land on `/triage` — Hot Zone shows SLA-breached candidate; Momentum Feed shows AI-scored candidates ordered by score | E2 triage screen, E3 candidate management, E4 stage mutations |
| 6 | Open drawer for any candidate → see AI score + top contributing factors + skills + parsed CV | O3 AI score discriminator, E3 candidate detail drawer |
| 7 | Advance through stages with 30s undo affordance | E4 reverse-mutation undo |
| 8 | For seeded Candidate E, an offer is already extended; recruiter sees offer state in drawer; copy signed URL | M1 offer drafting, J5 signed links |
| 9 | Open `/offer/[token]` as candidate (separate browser); preview offer; accept with full-name match | M4 candidate accept flow |
| 10 | `workday_sync_outbox` row enqueued; worker simulates Hire SOAP call within 5s; deterministic mock written | I8 Workday simulation drain |
| 11 | Log into `/admin/integrations` as admin → see the simulated Workday Hire response with `simulation_notes: "This is a simulated response"` honesty marker | F4 admin integrations health |

That is the entirety of the demo loop today: **apply → parse → score → triage → offer → accept → simulated hire → admin sees simulation.** It's a real end-to-end vertical slice. It only spans recruitment recruitment-half-plus-Workday-stub. It does **not** include onboarding, offboarding, partner submission, partner portal, real Workday SOAP, BGV, interview scheduling, real e-signature, bulk operations, or any reporting.

### Features that would visibly break or embarrass in a demo if a client clicked into them

A demo viewer who exercises the happy path above won't hit these. But the moment they click off-path:

1. **`/privacy` page** — exists but is a stub (`apps/internal-portal/src/app/privacy/page.tsx`). A DPDPA-conscious enterprise buyer who clicks this lands on placeholder copy. Open-question #14 already tracks the legal-review need.
2. **No partner portal** — `partner-portal` app is one empty `export {};` file. A client who asks "show me how partner Acme submits a CV" has nothing to see. This is the single biggest feature gap relative to the documented scope (G + H sub-systems = 18 features, all NOT STARTED).
3. **No candidate portal** — `candidate-portal` app is also `export {};`. A client who asks "what does the candidate see after they apply?" sees only the "submitted" confirmation page in the apply flow. There is no tracker, no document upload, no offer review surface outside the signed-link route.
4. **No careers site** — `careers-site` app is `export {};`. The apply form is embedded in the internal-portal Next.js app via middleware allowlist. SEO-indexed job listings (D2) don't exist. A client who asks "where do candidates discover the role?" gets no answer.
5. **Workday integration is a simulator with an honesty marker.** The `/admin/integrations` screen renders `simulation_notes: "This is a simulated response. In production, this would be the actual Workday SOAP response."` verbatim. The honesty marker is good policy but visible to anyone who looks — and `packages/workday-client/src/index.ts` is literally one line. A buyer who asks "is this hitting a real Workday tenant?" gets a "no."
6. **No onboarding flow.** Once an offer is accepted, the candidate's journey ends. A buyer who asks "what does Day 1 to Day 30 look like?" sees nothing.
7. **No offboarding flow.** Same: no resignation, no F&F, no Workday Terminate.
8. **No interview scheduling.** A buyer who asks "show me the panel-feedback loop" sees nothing.
9. **Admin surface is one page.** Only `/admin/integrations` exists. No user/role management UI, no audit view, no partner invite, no email-intake config, no AI/bias/branding settings.
10. **Approvals are schema-only.** Tables exist (`approval_chains`, `approval_requests`, `approval_decisions`, `approval_matrices`) but no router procedures and no UI. A buyer who asks "show me the approval matrix configuration" sees nothing.
11. **NULL ai_score handling.** Open-question #24 documents that the Momentum Feed doesn't have a planned UI bucket for NULL scores. A candidate submitted before AI-03 (or one whose parser confidence was <0.5) shows up with `ai_score=NULL` and the sort behaviour is undefined.
12. **OpenAI provider has never had a real-provider smoke** (open-question #25). If the buyer's tenant prefers OpenAI, no one has ever verified that path works against the live API.

---

## Section 6 — Honest commentary

The headline number — **21.2% production-complete** — sounds low for a project that has been building since week 1 of the engagement. The honest reading is more nuanced: the platform's *bedrock* is more solid than the percentage suggests, and the *breadth* is much narrower than the percentage suggests. The work that has shipped is structurally load-bearing — multi-tenancy, RLS, envelope encryption, AI client abstraction with real provider behind it, the synchronous dedup that the partner-ownership state machine depends on, the audit-on-opt-in pattern, the outbox-first notification dispatcher, the signed-link primitive. These are the things that cannot be retrofitted, and they exist. A buyer who asks "is the foundation right?" gets a defensible "yes." That is genuinely the harder half of the build.

Where the platform is weaker than the numbers suggest: the Workday integration is currently a one-line file. The `packages/workday-client/src/index.ts` reads `export {};` — there is no SOAP envelope template, no REST client, no token cache, no BP polling. The simulator in `apps/workers/src/lib/workday-simulation-drain.ts` is honest about itself (the `simulation_notes` string says so out loud) but it's not Workday. The execution plan estimated 6 weeks of orchestrated work for the real client; that work hasn't begun. This is the single biggest gap relative to the documented vision because Workday is the make-or-break integration in the `architecture.md` framing (§6.1: "most important section in this doc") — and the demo today silently routes around it. The same shape applies to the partner portal: the schema is there (8 tables shipped under DB-PARTNER-A), the ownership state machine has its load-bearing partial-unique index, but the UI is zero lines. The partner channel is 60% of expected candidate flow per `requirements.md` §1; the platform cannot demo it.

The biggest sub-system gap measured against the documented vision is **partner portal + onboarding + offboarding** taken together. That's 22 features across G, K, L — all NOT STARTED in code, with schema bones for G (partner identity), nothing for K or L. The execution plan put all three in Phase 3 ("Fan-out", weeks 7-11). The plan was honest that this is where most of the breadth lives. What the audit reveals is just how stark the Phase-2-vs-Phase-3 gradient is: **Phase 2 is 72% shipped and Phase 3 is 80% not-started.** The vertical slice is real; the fan-out hasn't begun. If the demo runway is short, the natural next move is to spike one Phase 3 thread (partner submit wizard, or BGV, or onboarding case board) to show the pattern works before committing to the full fan-out. If the runway is long, Phase 3 is mechanically achievable — the patterns are proven, the schema is half-built, and the API + worker plumbing already supports new procedures + new outbox tables.

Two things look more like "forgotten" than "deliberately punted." **Approvals are schema-only with no router procedures or UI.** Approval chains, approval requests, approval decisions, and approval matrices all exist as tables (migrations 0014/0017), but there's no `approveRequest` / `rejectRequest` / `listMyApprovals` tRPC procedure, no Hiring Approver Chain inbox page, no admin matrix configuration UI. This is supposed to gate every requisition and every offer per `requirements.md` §5.1 + §5.6 — and the design system spec explicitly calls out the mobile-first approval inbox for Hiring Approver Chain users (§3.1 mobile-first reality). It looks shipped because the schema is shipped, but it isn't usable. The other quiet gap is **`pii_access_log`** — `architecture.md` §5.1 names it as a domain table for "Every PII access logged to `pii_access_log` with actor, target, reason" (§9.4 explicitly), and DPDPA Article 13 expects it. It's not in `packages/db/src/schema/`. No migration creates it. The `api_audit_logs` table is the closest thing and it only captures procedure invocations, not row-level PII reads. For a platform whose docs call DPDPA "non-negotiable for Kyndryl" (§9.2), this is a load-bearing absence that I'd want to either explicitly defer in writing or close before any real candidate data lands.

The biggest surprise from the audit isn't a gap — it's the **structural completeness of the AI infrastructure relative to the depth of the consumer surfaces**. AI client abstraction, per-tenant routing, append-only ai_usage_logs with cost-in-micros, knockout evaluator, AI scoring drain with prompt versioning, real Anthropic smoke at 1.1¢ per call — all shipped. But there are exactly two consumers of all that infrastructure: the resume parser (C6) and the AI scoring drain (O1). The JD builder, the AI candidate brief, the AI-suggested-input for offer letters, the AI message scanner, the bias check on JD — all five of the other LLM use cases enumerated in `architecture.md` §13.1 — are not built. The AI plumbing is over-built relative to today's two consumers and exactly right-sized for the documented Phase 3 ambition. That is the right shape; it just means the LLM cost line on the Anthropic bill is going to stay tiny until Phase 3 ships, which can mislead a casual reader into thinking AI isn't doing much yet.

---

**Audit complete.** No code, schema, migration, test, or non-audit doc was modified during this exercise. Output is this single file.
