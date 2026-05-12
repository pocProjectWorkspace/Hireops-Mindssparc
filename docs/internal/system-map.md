# HireOps — System Overview Map

**Status:** Internal model derived from the four design docs in `/docs`.
**Last revised:** 2026-05-08 (initial pass).
**Sources:** `requirements.md`, `architecture.md`, `workday-adr.md`, `partner-wireflows.md`.

This is a structured representation of the system, written to support new questions. Every claim cites a source. Where the source is unclear or the docs disagree, the contradiction is recorded in `open-questions.md`.

---

## Product model

HireOps is a multi-tenant SaaS platform — one codebase, one production deployment, many enterprise tenants — per `requirements.md` §1.5 and `architecture.md` §1, §1.1. The system map below currently models the system as if it serves a single tenant; that simplification is intentional and tracks what the source docs themselves describe today. The Multi-Tenancy ADR (forthcoming, ADR-002) layers in tenant isolation across the schema, the request path, and the integration credential model. Until the ADR lands, treat every reference to "Kyndryl" in the entries below as "Tenant #1, the first POC customer." Personas, lifecycle stages, data entities, integrations, and the workspace map remain accurate per-tenant; multi-tenancy adds `tenant_id` scoping and per-tenant configuration around them.

---

## a) Personas

The personas listed below are taken directly from `requirements.md` §3 (3.1 keep-as-is, 3.2 restructure, 3.3 new). `requirements.md` §3.3 has been updated to read `Final persona count: 13` and the supporting math has been corrected (Lovable's 7 + 6 net-new = 13). The enumeration below lists all 13.

The "primary apps" column maps each persona to apps in this monorepo. The internal-portal absorbs the bulk of internal users; portal split is per `architecture.md` §4.1 (candidate, partner, internal each own a bundle) and the IA in `partner-wireflows.md` §2.

### Recruiter (TA Specialist) — internal (SSO)

Owns sourcing, shortlisting, and interview coordination for an assigned set of requisitions. At 300 hires/month each recruiter juggles ~30–60 candidates simultaneously, and the platform must support that density (`requirements.md` §3.1, §5.3, §5.5). Top three actions: shortlist against AI score, schedule interviews against panel availability, drive candidates through stage transitions to offer. Primary apps: `apps/internal-portal`. Auth tier: Kyndryl SSO via SAML/OIDC (`architecture.md` §9.1).

### Requirement Owner / Hiring Manager — internal (SSO)

Creates requisitions and JDs, reviews candidates, and signs off on hires. A "light-touch user — fewer than 5 minutes per candidate review", described as "mobile-first reality" (`requirements.md` §3.1). Top three actions: open a requisition, review and approve/reject candidates, give a final hire decision. Primary apps: `apps/internal-portal`, with mobile-responsive flows (`requirements.md` §9.10). Auth tier: Kyndryl SSO.

### Interview Panel — internal (SSO)

Conducts interviews and submits structured scorecards. Panel utilisation is identified as the bottleneck at 300/month (`requirements.md` §3.1, §5.5). Top three actions: read the AI-generated candidate brief, run the interview (Zoom/Teams), submit scorecard with feedback against an SLA (`requirements.md` §5.5). Primary apps: `apps/internal-portal` (mobile-responsive). Auth tier: Kyndryl SSO.

### Candidate — external (Supabase Auth, candidate tenant)

The most-touched persona — the one whose NPS and offer-acceptance rate the platform is judged on (`requirements.md` §3.1). Top three actions: apply (via career site, partner submission, or direct), track application status and self-pick interview slots, accept the offer and complete pre-board document collection (`requirements.md` §5.3, §5.5, §5.6, §7.1). Primary apps: `apps/candidate-portal` and `apps/careers-site` (anonymous apply path). Auth tier: email + password, magic link, or phone OTP, MFA optional (`architecture.md` §9.1).

### Admin — internal (SSO)

System owner: configures roles, integrations, AI settings, workflows, branding, and policies (`requirements.md` §10.7). Top three actions: manage user/role assignments, run the audit/governance views including ownership disputes, configure integrations and notification templates. Primary apps: `apps/internal-portal`. Auth tier: Kyndryl SSO.

### HR Head — internal (SSO) *(restructured)*

`requirements.md` §3.2 recommends splitting into TA Lead (operational: pipeline health, recruiter performance, SLA breaches) and HR Director (strategic: market intelligence, cost-per-hire, governance, audit), but explicitly says "for POC, ship as one persona with role-based view toggles; split later." Top three actions for the merged POC view: oversee multi-level approvals, monitor pipeline + cost-per-hire, run governance + audit (`requirements.md` §10.3). Primary apps: `apps/internal-portal`. Auth tier: Kyndryl SSO.

### HR Operations — internal (SSO) *(renamed from HR Team)*

Owns the back-half of recruitment plus onboarding/offboarding kickoff: HR rounds, offer drafting/approval, document verification, BGV coordination, exit interviews (`requirements.md` §3.2, §10.4). Top three actions: schedule HR final rounds and draft offers, manage onboarding/offboarding cases, drive document verification and BGV coordination. Primary apps: `apps/internal-portal`. Auth tier: Kyndryl SSO.

### People Ops / Onboarding Specialist — internal (SSO) *(new)*

Owns Day -7 to Day 30 of new-hire lifecycle, distinct from recruitment (`requirements.md` §3.3, §7). Top three actions: drive the onboarding case board (BGV, docs, IT), coordinate Day-1 logistics and manager handoff, escalate stuck Workday Hire BPs (`workday-adr.md` §6.4 names "People Ops" as the escalation owner for stuck BPs). Primary apps: `apps/internal-portal`. Auth tier: Kyndryl SSO.

### IT / Workplace Services — internal (SSO) *(new)*

Owns laptop provisioning, software licences, badge access, deprovisioning on exit (`requirements.md` §3.3, §7.3, §8.3). Top three actions: work the IT provisioning queue on new joins, maintain the asset register, drive deprovisioning + access revocation on exit. Primary apps: `apps/internal-portal`. Auth tier: Kyndryl SSO.

### HR Partner — external (separate auth tenant or email-only)

The single biggest source of candidate flow (`requirements.md` §3.3, §6). Two tiers (`requirements.md` §6.1, `partner-wireflows.md` §3 vs §4):

- **Empanelled** — MSA-bound, gets the full partner portal. Top three actions: submit candidates against open reqs (single + bulk in Wave 2), track own candidates' pipeline, manage commercials/invoices.
- **Ad-hoc** — no portal access; submits CVs by email to per-req aliases (`cvs-{req-id}@kyndryl-hireops.com`) plus a single `cvs-talent-pool@…` alias for speculative submissions, with partner attribution by sender-domain lookup against `ad_hoc_partner_domains` (per `requirements.md` §6.5 and `architecture.md` §7.9, both updated in the resolution pass). The "persona" never logs in.

Primary apps: empanelled = `apps/partner-portal`; ad-hoc = no UI (system parses inbound email). Auth tier (empanelled): magic-link + mandatory MFA on a separate auth tenant from internal users and candidates (`architecture.md` §7.2).

### Background Verification Vendor — external (API-only)

Read-only candidate context + write-only verification outcomes via webhooks (`requirements.md` §3.3, §7.1, `architecture.md` §8.1). No UI. Top three actions: receive a BGV initiation request, run checks asynchronously (1–10 days), post results back via webhook. Primary apps: none (API integration). Auth tier: API key + IP allowlist (`architecture.md` §9.1).

### Hiring Approver Chain — internal (SSO)

Multi-level approvers for headcount, offers above grade, and NPS-impacting decisions; some approvals originate in Workday and reflect back into HireOps (`requirements.md` §3.3, §5.1). Top three actions: receive an approval request notification, review the request context, approve/reject with comment. The doc describes this as "lightweight inbox view ... often mobile" but does not specify whether they live inside the internal portal or in a thinner channel. Primary apps: `apps/internal-portal` (assumed; not explicit — flagged in `open-questions.md` §b). Auth tier: Kyndryl SSO.

### Employee (post-hire) — external (transitions to SSO once provisioned)

Once onboarded, the candidate becomes an employee. The candidate portal continues to serve them with extended scope: data access, exit initiation, document downloads (`requirements.md` §3.3, §8.1). Top three actions: complete onboarding milestones (training, check-ins, probation), download payslips/letters, initiate resignation. Primary apps: `apps/candidate-portal` (continues post-hire). Auth tier transitions: candidate auth → SSO once provisioned (`architecture.md` §9.1 row "Employees (post-hire)").

---

## b) Lifecycle stages

Sourced from the canonical state machine in `requirements.md` §4. The diagram is structured as four bands: Sourcing channels, Recruitment, Onboarding, Offboarding. "Sourcing channels" is the set of inbound paths feeding the recruitment band rather than a stage; the lifecycle stages proper start at Headcount Approved.

| # | Stage | Trigger that moves a record into this stage | Responsible persona |
|---|---|---|---|
| 1 | Headcount Approved | Annual/quarterly headcount budget approved (envelope, before reqs) | HR Head + Hiring Approver Chain (`requirements.md` §5.1) |
| 2 | Requisition Created | Hiring Manager opens a req against the headcount envelope | Hiring Manager (`requirements.md` §5.1, §10.2) |
| 3 | JD Approved | Multi-level approval workflow clears the JD | Hiring Manager + Hiring Approver Chain (`requirements.md` §5.1, §5.2) |
| 4 | Posted | Req published to careers site / job boards | Recruiter (`requirements.md` §5.2, §5.3) |
| 5 | Live | Req actively receiving applications | Recruiter (`requirements.md` §4) |
| 6 | Application Received | Candidate submits via direct apply / partner submission / email-intake / job board | System on behalf of Candidate or HR Partner (`requirements.md` §5.3, §6, `partner-wireflows.md` §3.5, §4) |
| 7 | AI Screen & Score | Resume parsed; AI score against JD computed | System (worker), reviewed by Recruiter (`requirements.md` §5.4) |
| 8 | Recruiter Shortlist | Recruiter accepts or rejects after AI score | Recruiter (`requirements.md` §5.4) |
| 9 | Tech Interview | Technical round scheduled and conducted | Interview Panel + Recruiter (`requirements.md` §5.5) |
| 10 | HR Round | HR final round scheduled and conducted | HR Operations (`requirements.md` §5.5, §10.4) |
| 11 | Offer Drafted | Comp recommendation + multi-level approval kicks off offer | HR Operations + Hiring Approver Chain (`requirements.md` §5.6) |
| 12 | Offer Accepted | Candidate countersigns via e-signature | Candidate (triggers Workday Pre-Hire per `requirements.md` §7.2) |
| 13 | Pre-board Initiated | Offer accepted → onboarding case opens | People Ops (`requirements.md` §7.1) |
| 14 | BGV Cleared | BGV vendor returns verification report | BGV Vendor (webhook); People Ops monitors (`requirements.md` §7.1, `architecture.md` §8.1) |
| 15 | Document Collected | Candidate uploads gov ID / address / employment / education / payroll forms | Candidate; People Ops verifies (`requirements.md` §7.1) |
| 16 | Workday Hire Sync | Pre-Hire fires automatically on offer-accept (e-sign webhook → `Put_Applicant`); Hire fires automatically on Day 1 (00:00 IST scheduler → `Hire_Employee` + BP completion). Both flows are auto-triggered; no human click. | System (`workday-sync-worker`); People Ops handles failures (`requirements.md` §7.2, `workday-adr.md` §5.1, §5.2 sequences) |
| 17 | IT Provisioned | Laptop, AD/Okta, Slack/Teams, role-app access (SCIM where possible) | IT / Workplace Services (`requirements.md` §7.3) |
| 18 | Day 1 Welcome | First working day; orientation + buddy + 1:1 scheduled | People Ops + Manager (`requirements.md` §7.3) |
| 19 | 30-Day Check-in | Auto-scheduled pulse + manager + People Ops touchpoint at Day 30 | Manager + People Ops (`requirements.md` §7.3) |
| 20 | Probation Confirmed | Probation review (default 3 or 6 months) passes | Manager; HR Operations records (`requirements.md` §7.3); also unlocks partner full fee per `requirements.md` §6.8 |
| — | ACTIVE EMPLOYEE | Terminal recruitment-side state; offboarding may follow months/years later (`requirements.md` §4) | n/a |
| 21 | Resignation Initiated | Employee submits resignation in candidate/employee portal (or HR-led termination) | Employee or HR Operations (`requirements.md` §8.1) |
| 22 | Notice Period | Manager acknowledges within 48h; notice clock running | Manager (`requirements.md` §8.1, §8.2) |
| 23 | Knowledge Transfer | KT plan templated by role family; manager + employee confirm completion | Manager + Employee (`requirements.md` §8.2) |
| 24 | Exit Interview | Online questionnaire + optional 1:1 with HR | HR Operations (`requirements.md` §8.3) |
| 25 | Asset Returned | Laptop, peripherals, ID card, devices each tracked + signed off | IT / Workplace Services (`requirements.md` §8.2, §8.3) |
| 26 | Access Revoked | SCIM-driven revoke across all apps; AD disabled | IT / Workplace Services (`requirements.md` §8.3) |
| 27 | F&F Settled | Salary + leave encashment + bonus pro-rata − loans − notice-shortfall | HR Operations + Finance (`requirements.md` §8.2, §8.3) |
| 28 | Workday Terminate | SOAP `Terminate_Employee` + `Maintain_User_Account` (Account_Disabled=true) | System; HR Operations confirms (`requirements.md` §8.3, `workday-adr.md` §1, §5.1) |
| — | ALUMNI | Terminal state; rehire-eligibility flag + DPDPA-bound retention horizon set (`requirements.md` §4, §8.3) | n/a |

Crossing-cutting: every stage transition is auditable, has an SLA, and has a responsible persona; partner ownership/fee attribution sits as a parallel ledger that locks at offer-accept and reconciles at probation-pass (`requirements.md` §4 closing note, §6.4, §6.8).

---

## c) Data model entities

Entities below come primarily from `architecture.md` §5.1 (data model — extending Lovable's schema), with the Tenancy core group (added per ADR-002) at the top, the Partners group from `architecture.md` §7 + `/docs/partner-data-model.md`, and reference tables explicitly marked.

For each entity: one-line description, the foreign keys called out in the source, and a tenancy marker. **Per ADR-002, every domain entity carries `tenant_id UUID NOT NULL REFERENCES tenants(id)` and is tenant-scoped via RLS as the outermost predicate; reference tables (rows that are platform-shared facts, not tenant data) are explicitly marked `reference (tenant-agnostic)`.** Where the source does not specify foreign keys explicitly, the FK column reads "(not specified in §5.1)" — that absence does not imply none should exist; it reflects the doc's level of detail.

### Tenancy core (per ADR-002)

- **tenants** — One row per enterprise customer. Slug drives subdomain routing; `tier` discriminates 'standard' / 'sandbox' / 'dedicated' (future); `settings` JSONB holds cosmetic config. Most users see only `WHERE id = current_tenant_id()`; platform-level admins (HireOps internal staff) see all rows via service-role escalation (`architecture.md` §5.1 Tenancy core; `multi-tenancy-adr.md` §5.1, §5.4). FKs: none upstream (root tenancy table). Tenancy: this *is* the tenancy spine; not itself tenant-scoped.
- **tenant_encryption_keys** — Per-tenant Data Encryption Key (DEK) wrapped by master KMS Key Encryption Key (KEK). Read only by service-role workers when decrypting `integration_credentials`. RLS+FORCE on with no policies for `authenticated` (default-deny); `service_role` bypasses RLS as the only legitimate access path (`architecture.md` §5.1 Tenancy core; `multi-tenancy-adr.md` §5.5; enforced by `packages/db/src/lint-rls.ts` allowlist, FND-15c). FKs: `tenant_id` → `tenants(id)` ON DELETE CASCADE.
- **integration_credentials** — Per-tenant integration secrets (Workday ISU, BGV API keys, IdP secrets, e-sign client secrets, OAuth client credentials, etc.) encrypted with the tenant's DEK using AES-GCM envelope encryption. Replaces Lovable's mock `integrations` table; partners with `integration_endpoints`, `integration_runs`, `integration_failures` for endpoint config + sync log + retry state (`architecture.md` §5.1, §6.3; `multi-tenancy-adr.md` §5.5). FKs: `tenant_id` → `tenants(id)` ON DELETE CASCADE. Tenant-scoped (outermost) on read; service-role write from worker tier only.

### Identity & lifecycle

All tenant-scoped per ADR-002.

- **persons** — Canonical person ID across candidate → employee → alumni, providing stable identity across lifecycle records. FKs: none upstream beyond `tenant_id`. Referenced by `candidates`, `employees`, `candidate_ownership_claims`, `candidate_dedup_attempts.resolved_to_person_id` (`architecture.md` §5.1, §5.2, §7.4). Tenant-scoped.
- **candidates** — Recruitment-side identity. Split out from Lovable's combined table so that consent and retention semantics differ from employee semantics. FKs: `tenant_id` → `tenants`; `person_id` → `persons` (`architecture.md` §5.1 "Tables to restructure", §5.2). Tenant-scoped.
- **employees** — Post-hire record; links to Workday Worker ID. FKs: `tenant_id` → `tenants`; `person_id` → `persons`; linked through `workday_worker_links.worker_wid` to Workday (`architecture.md` §5.1, §5.2). Also referenced by `partner_fees.hire_id` (`architecture.md` §7.8). Tenant-scoped.
- **employee_history** — Promotion, transfer, manager-change events for an employee. FKs: `tenant_id` → `tenants`; `employee_id` → `employees` (inferred — not explicit in §5.1). Tenant-scoped.
- **alumni** — Post-employment retention record. FKs: `tenant_id` → `tenants`; `person_id` → `persons` (`architecture.md` §5.2 narrative; full schema TBD when offboarding analytics ships in Wave 2). Tenant-scoped.
- **profiles** (kept from Lovable) — User profile data for internal users (`architecture.md` §5.1 keep-as-is list). Tenant-scoped (a user belongs to exactly one tenant per the ADR-002 model).
- **user_roles** (kept from Lovable) — RBAC role assignments; extended for new personas (`architecture.md` §5.1, §9.2). Tenant-scoped (role grants are scoped to the user's `tenant_id`).

### Position & headcount

All tenant-scoped per ADR-002.

- **positions** — Workday-mirrored position records ("a slot in the org chart" per `requirements.md` §5.1). FKs: `tenant_id` → `tenants`; links to `workday_position_links.position_wid` for Workday WID (`architecture.md` §5.1, §6.1; cross-ref `workday-adr.md` §5.1). Tenant-scoped.
- **headcount_envelopes** — Approved hiring budget by org/period. Requisition creation deducts from envelope (`requirements.md` §5.1, `architecture.md` §5.1). FKs: `tenant_id` → `tenants`; org/period references (not specified in §5.1). Tenant-scoped.
- **position_assignments** — Which person occupies which position when. FKs: `tenant_id` → `tenants`; `person_id` → `persons`, `position_id` → `positions` (`architecture.md` §5.1; FKs inferred from semantics). Tenant-scoped.

### Recruitment core (kept from Lovable, listed because the schema depends on them)

All tenant-scoped per ADR-002.

- **requisitions** — Open hiring against a position. (`architecture.md` §5.1 keep-as-is.) Tenant-scoped.
- **jobs / jd_versions / jd_skills** — JD content + per-version skills with weights (`architecture.md` §5.1). Tenant-scoped.
- **applications** — Candidate's application against a requisition (`architecture.md` §5.1). Tenant-scoped. Carries `source_partner_id` and `submitted_by_partner_user_id` to model partner submissions without a separate `submissions` table.
- **interviews / interview_feedback / interview_summaries / interview_plans** — Interview scheduling, panel feedback, AI summaries, plans (`architecture.md` §5.1). Tenant-scoped.
- **offers / offer_recommendations** — Drafted offers and AI/market comp recommendations (`architecture.md` §5.1). Tenant-scoped.
- **bias_rules** — Fairness/bias rule config; each tenant configures their own (`architecture.md` §5.1). Tenant-scoped.
- **requisition_knockouts** — Knockout questions per req (`architecture.md` §5.1 recruitment-core extension). Tenant-scoped.

### Onboarding

All tenant-scoped per ADR-002 except `document_types`, which is a reference table.

- **onboarding_cases** — One per new hire (`architecture.md` §5.1). FKs: `tenant_id` → `tenants`; `person_id`/`employee_id` → identity tables (inferred). Tenant-scoped.
- **onboarding_tasks** — Atomic tasks (collect doc, IT provision, training, etc.). FKs: `tenant_id` → `tenants`; `case_id` → `onboarding_cases` (inferred). Tenant-scoped.
- **document_types** — Lookup table of document type definitions (PAN, Aadhaar, BIR 2316, etc.) discriminated by `geography_code`. The rows are platform-shared facts; tenants pick from the shared set, they do not author their own document types (`architecture.md` §5.1; `requirements.md` §7.1). **Reference (tenant-agnostic) — no `tenant_id`.** Per-tenant document policies, if any in future, would live in a separate `tenant_document_policies` table — not in Wave 1 scope.
- **onboarding_documents** — KMS-encrypted document blob metadata (`architecture.md` §5.1). FKs: `tenant_id` → `tenants`; `case_id` → `onboarding_cases` (inferred); `document_type_id` → `document_types`; blob URL points to S3 + KMS (`architecture.md` §3, §9.3). Tenant-scoped.
- **bgv_runs** — One per initiated BGV vendor coordination (`architecture.md` §5.1). FKs: `tenant_id` → `tenants`; `case_id` → `onboarding_cases` (inferred); links out to vendor record. Tenant-scoped.
- **bgv_results** — Vendor outcomes / verification report (`architecture.md` §5.1). FKs: `tenant_id` → `tenants`; `bgv_run_id` → `bgv_runs` (inferred). Tenant-scoped.
- **it_provisioning_requests** — Handoff to IT persona for laptop/AD/SCIM (`architecture.md` §5.1). Tenant-scoped.
- **asset_assignments** — Laptop, peripherals, badge tracking on issue (`architecture.md` §5.1). Tenant-scoped.

### Offboarding

All tenant-scoped per ADR-002.

- **offboarding_cases** — One per resignation or termination (`architecture.md` §5.1). Tenant-scoped.
- **offboarding_tasks** — Atomic tasks (KT, asset return, F&F, etc.) (`architecture.md` §5.1). Tenant-scoped.
- **exit_interviews** — Structured + free-text responses (`architecture.md` §5.1). Tenant-scoped.
- **asset_returns** — Hardware return per offboarding case (`architecture.md` §5.1). Tenant-scoped.
- **final_settlements** — F&F calculation rows (`architecture.md` §5.1). Tenant-scoped.

### Compliance

All tenant-scoped per ADR-002.

- **consents** — DPDPA consent records, 7-year retention (`architecture.md` §5.1, §10.1; `requirements.md` §6.9). Tenant-scoped.
- **data_principal_requests** — Access/correction/erasure/portability requests (`architecture.md` §5.1, §10.2). Tenant-scoped.
- **data_retention_schedules** — Per-data-category retention rules; each tenant configures retention; nightly retention job applies them (`architecture.md` §5.1, §10.3). Tenant-scoped.
- **pii_access_log** — Every PII read with actor/target/reason; 7-year retention (`architecture.md` §5.1, §9.4). Tenant-scoped.
- **audit_logs** (kept from Lovable) — Every state transition (`architecture.md` §5.1, §9.4; `requirements.md` §4). Tenant-scoped.

### Workday sync state

All tenant-scoped per ADR-002.

- **workday_sync_jobs** — One row per sync attempt; carries deterministic `business_key`, used for idempotency (`architecture.md` §5.1; `workday-adr.md` §5.6). Tenant-scoped.
- **workday_worker_links** — HireOps `person_id` ↔ Workday `worker_wid` (`architecture.md` §5.1). Tenant-scoped.
- **workday_position_links** — HireOps `position_id` ↔ Workday `position_wid` (`architecture.md` §5.1). Tenant-scoped.
- **workday_reconciliation_runs** — Daily reconciliation outcomes; surfaces drift to admin dashboard (`architecture.md` §5.1; `workday-adr.md` §5.8). Tenant-scoped.
- **integration_endpoints / integration_runs / integration_failures** — Endpoint config, sync log, retry state for any integration (Workday, BGV, calendar, etc.) (`architecture.md` §5.1 "Tables to restructure"). Tenant-scoped. (`integration_credentials` itself lives in Tenancy core above.)

### Approvals

All tenant-scoped per ADR-002.

- **approval_chains** — Definition of approval hierarchy per type (e.g., requisition vs offer vs grade-based) (`architecture.md` §5.1). Tenant-scoped.
- **approval_requests** — Lovable already has this; extend with new persona scopes (`architecture.md` §5.1). Tenant-scoped.
- **approval_decisions** — Per-step approve/reject with comment (`architecture.md` §5.1). Tenant-scoped.
- **approval_matrices** — Configurable approval-matrix engine per ADR-002 Decision 4: rules JSONB per `matrix_type` ('requisition' | 'offer' | 'headcount' | 'partner_invite') (`architecture.md` §5.1; `multi-tenancy-adr.md` §5.4). Tenant-scoped.

### Notifications

All tenant-scoped per ADR-002.

- **notification_templates** — Lovable has `whatsapp_templates`; extend for email/SMS/push/in-app/Slack (`architecture.md` §5.1, §3 diagram, `requirements.md` §9.5). Tenant-scoped.
- **notification_dispatches** — Log of every send (`architecture.md` §5.1). Tenant-scoped.
- **notification_preferences** — Per-user channel preferences (`architecture.md` §5.1, `requirements.md` §9.5). Tenant-scoped.
- **whatsapp_*** / **messaging_providers** (kept from Lovable) — WhatsApp Business scaffolding (`architecture.md` §5.1). Tenant-scoped.

### Search

- **search_documents** — Denormalised tsvector index for Postgres FTS (sufficient until ~500k rows, then move to Typesense/OpenSearch) (`architecture.md` §5.1, §5.3). Tenant-scoped.

### Partners (sourced from `architecture.md` §7 + `/docs/partner-data-model.md`)

All tenant-scoped per ADR-002. The full schema with column definitions, indexes, and RLS summaries is in `/docs/partner-data-model.md`; entries below are pointers.

- **partner_orgs** — Empanelled or ad-hoc organisation. FKs: `tenant_id` → `tenants`; referenced by `partner_users.partner_org_id` and `candidate_ownership_claims.partner_org_id` (`architecture.md` §7.3, §7.4). Tenant-scoped.
- **partner_users** — Users belonging to a partner org with status (active/suspended). FKs: `tenant_id` → `tenants`; `partner_org_id` → `partner_orgs`, `user_id` → identity layer (`architecture.md` §7.3). Tenant-scoped.
- **partner_msa** — One row per `partner_org_id`; carries fee structure, exclusivity window, holdback, MSA validity dates, signed MSA URL. FKs: `partner_org_id` → `partner_orgs` (PK); `tenant_id` → `tenants` (denormalised from `partner_orgs.tenant_id` for index leadership) (`architecture.md` §7.8). Tenant-scoped.
- **partner_fees** — One row per fee accrual at hire date. FKs: `tenant_id` → `tenants`; `partner_org_id` → `partner_orgs`, `hire_id` → `employees`, `ownership_claim_id` → `candidate_ownership_claims`. Carries `msa_snapshot` JSONB so historical disputes are resolved against the MSA in force at hire date, never against the live `partner_msa` (`architecture.md` §7.8). Tenant-scoped.
- **candidate_ownership_claims** — The state machine for partner ownership. FKs: `tenant_id` → `tenants`; `person_id` → `persons`, `partner_org_id` → `partner_orgs`, `requisition_id` → `requisitions` (nullable for speculative). Carries unique partial index on **`(tenant_id, person_id, requisition_id) WHERE status = 'active'`** — the database-level guarantee against simultaneous ownership, now tenant-scoped per ADR-002 (`architecture.md` §7.4; `/docs/partner-data-model.md`). Tenant-scoped.
- **candidate_dedup_attempts** — Audit of every submission attempt that did not become a candidate. FKs: `tenant_id` → `tenants`; `attempted_by_partner_org_id` → `partner_orgs` (nullable), `resolved_to_person_id` → `persons` (nullable) (`architecture.md` §7.4). Tenant-scoped.

The remaining partner schema — `partner_invitations`, `partner_assignments`, `requisition_knockouts`, `partner_candidate_messages`, `intake_attempts`, `partner_activity_log`, `ad_hoc_partner_domains` — is consolidated in `/docs/partner-data-model.md` with full column definitions and is all tenant-scoped per ADR-002. Names that turned out to be aliases or deferred: `submissions` → use `applications` with `source_partner_id`; `partner_contracts` → alias for `partner_msa`; `placement_fees` → alias for `partner_fees`; `partner_invoices`, `payments` → Wave 3, separate doc.

### Other kept-from-Lovable

All tenant-scoped per ADR-002.

- **ai_usage_logs** — Token usage per feature; budget alerts (`architecture.md` §5.1, §13.2; `requirements.md` §10.7). Tenant-scoped.
- **kb_articles** — Knowledge base articles; each tenant has their own KB (`architecture.md` §5.1). Tenant-scoped.
- **workflows / workflow_runs** — Workflow engine config and execution (`architecture.md` §5.1; `requirements.md` §10.7). Tenant-scoped.

---

## d) External integrations

The "owning workspace package" column maps each integration to a package in this monorepo. Where the doc explicitly names a package (e.g., `packages/ai-client` for LLM, `packages/workday-client` for Workday), that's used directly; for other integrations the doc does not assign a package name, so the column reads either "TBD — not yet assigned" or a sensible inference from the workspace layout (`apps/api` for HTTP-side, `apps/workers` for async, `packages/*` for clients). Inferences are flagged.

| Integration | Direction | Protocol | Frequency | Owning workspace package | Source-of-truth doc |
|---|---|---|---|---|---|
| **Workday** | Both | SOAP (WS-Security) for staffing transactions; REST + WQL for reads | Real-time queued for hire/terminate; 15-min poll for positions; hourly for job profiles; nightly for org snapshot; nightly reconciliation at 03:00 IST | `packages/workday-client` (named) + `apps/workers` for sync worker | `workday-adr.md` (entire), `architecture.md` §6, §7.2 (cross-ref), `requirements.md` §9.1 |
| **LinkedIn (job board)** | Both | LinkedIn Recruiter System Connect (RSC) — partnership-tier API | Outbound: post on JD approval. Inbound: applicant pull via webhook/poll | TBD — not yet assigned (likely `apps/workers` with a job-board adapter) | `architecture.md` §8.2, `requirements.md` §5.3 |
| **Naukri (job board)** | Both | Naukri RMS / API | Same as LinkedIn | TBD — not yet assigned | `architecture.md` §8.2 |
| **Indeed (job board)** | In-bound dominant | Indeed Apply API | Inbound applicant webhook on apply | TBD — not yet assigned | `architecture.md` §8.2 |
| **BGV vendor** (HireRight / FirstAdvantage / AuthBridge) | Both | REST (initiate) + webhook (status callback) | Async; 1–10 days per check | TBD — not yet assigned (a `packages/bgv-client` may be warranted; not in the package list) | `architecture.md` §8.1, `requirements.md` §7.1 |
| **Identity Provider (Okta / Azure AD)** | Both | SAML/OIDC for SSO; SCIM for user provisioning | Real-time (auth); event-driven (SCIM) | TBD — auth lives across `apps/api` + `apps/internal-portal` | `architecture.md` §9.1, §8.4; `requirements.md` §9.3 |
| **Google Calendar API** | Both | OAuth + REST | Real-time, two-way sync | TBD — not yet assigned | `architecture.md` §8.3 |
| **Microsoft Graph (Outlook Calendar)** | Both | OAuth + REST | Real-time, two-way sync | TBD — not yet assigned | `architecture.md` §8.3 |
| **Zoom** | Out-bound dominant | OAuth + REST (create meeting); recording + transcript pulled post-call | Per-interview (event-driven) | TBD — not yet assigned | `architecture.md` §8.3, `requirements.md` §5.5 |
| **Microsoft Teams** | Out-bound dominant | OAuth + REST | Per-interview | TBD — not yet assigned | `architecture.md` §8.3 |
| **SendGrid (email)** | Out | SMTP / REST | Real-time transactional | TBD — likely `apps/workers` notification worker | `architecture.md` §8.5, `requirements.md` §9.5 |
| **Twilio (SMS)** | Out | REST | Real-time transactional | TBD — likely `apps/workers` notification worker | `architecture.md` §8.5 |
| **Twilio / 360dialog (WhatsApp Business)** | Both | REST + webhook | Real-time, two-way | TBD — likely `apps/workers` notification worker (Lovable scaffolding noted) | `architecture.md` §8.5, `requirements.md` §9.5 |
| **Anthropic Claude API (LLM primary)** | Out | HTTPS REST (Anthropic SDK) | Real-time per request | `packages/ai-client` (named; "All LLM calls through a thin abstraction") | `architecture.md` §8.6, §13.2; `requirements.md` §5.2, §5.4 |
| **AWS Bedrock (LLM fallback)** | Out | AWS SDK | Real-time per request | `packages/ai-client` | `architecture.md` §8.6, §13.1 |
| **DocuSign or Adobe Sign (e-signature)** | Both | REST + webhook | Real-time per offer | TBD — not yet assigned | `architecture.md` §8.7; `requirements.md` §5.6 |
| **AWS KMS / GCP KMS** | Out (ops) | AWS SDK | Real-time at write/read | TBD — likely cross-cutting (db + storage encryption) | `architecture.md` §3, §9.3 |
| **AWS Secrets Manager / HashiCorp Vault** | In (read) | AWS SDK | Real-time | TBD — cross-cutting; consumed by `apps/api`, `apps/workers`, `packages/workday-client` | `architecture.md` §6.3, §9.3; `workday-adr.md` §5.3 |
| **S3 / Cloudflare R2 (object storage)** | Both | AWS SDK / S3 API | Real-time per upload/download | TBD — likely `apps/api` for presigned URLs, `apps/workers` for processing | `architecture.md` §3, §4.2 |
| **Amazon SES (or equivalent) — email-intake** | In | SMTP → S3 event → worker | Event-driven on inbound mail | `apps/workers` (email-intake parser) | `architecture.md` §7.9, `requirements.md` §6.5, `partner-wireflows.md` §4 |
| **Kyndryl AP / Finance (SAP / Oracle / Coupa)** | Out | Format TBD per Kyndryl AP stack (API or PDF + email) | Per-invoice (event-driven), low frequency | TBD — Wave 3 work (`requirements.md` §11) | `architecture.md` §3, §7.8; `requirements.md` §6.8, §12 Q19 |
| **Sentry (error tracking)** | Out | Sentry SDK | Real-time | Cross-cutting; all apps + workers | `architecture.md` §12.5, §4.1 |
| **PostHog (product analytics)** | Out | PostHog SDK | Real-time | Cross-cutting; all frontends | `architecture.md` §12.5, §4.1 |
| **Datadog (logs / APM / metrics)** | Out | Datadog agent / SDK | Real-time | Cross-cutting; `apps/api`, `apps/workers` | `architecture.md` §12.5; `workday-adr.md` §5.9 |
| **PagerDuty (alerts)** | Out | PagerDuty integration | Event-driven | Cross-cutting | `workday-adr.md` §5.9 |
| **HackerRank / CodeSignal (technical assessments)** | Both | REST + webhook | Per-test | TBD — not yet assigned (out of Wave 1 scope) | `requirements.md` §5.5 (`Missing — required for tech roles`) |
| **LMS (training)** | Out (assignment) | Likely REST | Per-assignment | TBD — Wave 1 may be a stub | `requirements.md` §7.3 |
| **Cloudflare (WAF, rate limit, DDoS, geo routing)** | n/a (edge) | n/a (network) | Real-time | Infrastructure | `architecture.md` §3 (diagram) |

---

## e) Workspace map

The 12 packages defined in this monorepo (`README.md`, current scaffold). Each entry says what belongs there per the design docs, citing the source. Where the docs do not specify, the entry says so explicitly.

### apps/internal-portal — React + Vite

The recruiter / hiring-manager / panel / HR Operations / People Ops / IT / Admin / TA Lead+HR Director surface. SSO-gated via Kyndryl IdP (`architecture.md` §3, §9.1). Hosts every internal page concept inherited and modified from Lovable — see `requirements.md` §10 for the page-by-page disposition. Promoted as its own bundle (separate from candidate portal) per `architecture.md` §4.1 because the security posture, deployment cadence, and performance characteristics differ.

### apps/candidate-portal — React + Vite

The candidate (and post-hire employee) surface. Public sign-in via email/password / magic link / phone OTP, MFA optional (`architecture.md` §9.1). Carries: apply tracker, profile + DPDPA consent, document upload, interview slot picker, offer review + e-sign, onboarding journey, settings (data download, deletion, consent withdrawal) (`requirements.md` §10.6). Continues to serve the user post-hire as Employee (`requirements.md` §3.3).

### apps/partner-portal — React + Vite

The empanelled-partner surface (no ad-hoc — they have no UI). Magic-link + mandatory MFA, separate auth tenant from internal users and candidates (`architecture.md` §7.2). IA: dashboard, /reqs, /candidates (single + bulk + speculative + detail), /pipeline, /messages, /commercials, /team (admin only), /settings (`partner-wireflows.md` §2). Wave 1 ships a slice of this (login, dashboard, view-open-reqs, single-candidate submission, pipeline tracking) per `requirements.md` §11 Wave 1.

### apps/careers-site — Next.js (SSR)

Public, anonymous job board. SEO-critical (Google indexes job posts) — Next.js with SSR is chosen explicitly because a React SPA is the wrong tool for indexing (`architecture.md` §4.1). Hosts the apply form (mobile-first, CAPTCHA, rate limit, DPDPA consent on submit) and deep-links into the candidate apply flow (`requirements.md` §5.3, §10.9 P0). Open question: whether the apply originates here or on `careers.kyndryl.com` (`requirements.md` §12 Q3).

### apps/api — Node + Hono + tRPC

The application API surface. Custom Node.js service running Hono + tRPC, deployed on Fly.io / Render / Cloud Run (open decision in `architecture.md` §17 Q3). Hosts: tRPC procedures, webhook receivers, file-upload presigned-URL flow, per-portal permission middleware, content-scanner trigger for partner messages (`architecture.md` §3 diagram, §4.2). **Not** Supabase Edge Functions — reasons in `architecture.md` §4.3 (Workday SOAP > 60s; bulk fanout; long-running reconciliation; file processing; AI scoring at volume).

### apps/workers — Node + BullMQ

All async work. Workers documented across the docs: `workday-sync-worker` (`workday-adr.md` §5.2); BGV poll worker; notification worker; resume parsing worker; AI scoring worker; reconciliation jobs; partner email-intake parser; partner ownership reconciler; content-scanner worker (LLM-based, partner messages) (`architecture.md` §3 diagram). Backed by BullMQ on Redis (`architecture.md` §4.2, §5.4).

### packages/ui — Shared React component library

Shared design-system components, intended to host the shadcn/ui setup and Tailwind tokens carried over from Lovable (`architecture.md` §4.1, §14.1). Storybook is added at this layer for component documentation across the multi-persona system (`architecture.md` §4.1).

### packages/types — Shared TypeScript types

Domain model + API contracts shared across apps/api, apps/workers, and the four frontends. The docs do not call this package out by name; its scope is inferred from the monorepo layout (`README.md` workspace layout) and the standard practice of sharing tRPC types across server and client (`architecture.md` §4.2 "Hono + tRPC").

### packages/ai-client — Thin abstraction over LLM providers

Named explicitly in `architecture.md` §13.2: "All LLM calls through a thin abstraction (`packages/ai-client`) so models can be swapped without touching feature code." Hosts: provider selection (Anthropic Claude primary, AWS Bedrock fallback per §13.1), prompt versioning, structured-output enforcement, PII redaction before LLM call where possible, token-budget instrumentation, caching for deterministic prompts (`architecture.md` §13).

### packages/workday-client — SOAP + REST wrapper for Workday

Houses the SOAP envelope templates (handlebars per request, with WS-Security header), the REST + WQL client, OAuth 2.0 client-credentials token-cache logic (no refresh tokens — see `workday-adr.md` §1, §5.3), Business Process completion polling, and the typed mapping between HireOps fields and Workday fields. Consumed by `apps/workers` (the `workday-sync-worker` process) and on-demand by `apps/api` for worker reads. Lives separate from `apps/workers` because the same client is used in admin tooling and reconciliation jobs (`workday-adr.md` §5.6, §5.8).

### packages/db — Database schema, migrations, queries

Postgres schema (Supabase or Neon, ap-south-1 — open `architecture.md` §17 Q1, Q2), migrations, seed data, RLS policies, and typed query layer. Hosts the schema entities listed in (c) above. Lovable's RLS pattern with `has_role()` SECURITY DEFINER is reused; partner-side RLS is net-new and lives here too (`architecture.md` §4.2, §7.3, §14.1).

### packages/config — Shared runtime config + env loading

Shared environment variable loading and runtime config. The docs do not name this package or specify its exact contents. Inferred role: parsing/validating `.env` (zod-style), surfacing typed config to apps + workers, integrating with AWS Secrets Manager / Vault for secrets (`architecture.md` §6.3, §9.3 — secrets are explicitly "never in `.env` files in repo"). Flag: scope unclear from docs; will firm up once Wave 1 task design begins.
