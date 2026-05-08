# HireOps — Platform Architecture

**Version:** 0.1 (POC architecture draft)
**Date:** 8 May 2026
**Companion to:** `requirements.md`
**Context:** HireOps multi-tenant SaaS platform. Kyndryl's GCC POC is the first paying engagement (300 hires/month, full lifecycle, Workday as the customer-side HRIS-of-record where applicable) and becomes Tenant #1 in production.

---

## 1. Framing

HireOps is a multi-tenant SaaS platform. **One codebase, one production deployment, many enterprise tenants** — isolated from each other by `tenant_id`-scoped row-level security and per-tenant integration credentials. Each tenant configures their own Workday connection, their own approval matrix, their own partner ecosystem, their own BGV vendor, their own job-board contracts. The platform supports this through configuration, not customisation: when a customer needs something the platform doesn't yet offer, we add configurability for everyone, never bespoke code for one customer.

Kyndryl's GCC POC is funding the initial build of this platform. Kyndryl becomes Tenant #1 when the platform is production-ready. Subsequent tenants follow the same onboarding flow without code changes.

The Multi-Tenancy ADR (forthcoming, ADR-002) is the architectural decision-of-record for tenant isolation, configuration, integration credential management, and tenant onboarding. Until that ADR lands, this document describes the platform's logical architecture without elaborating tenant isolation in detail; the ADR layers in the multi-tenancy semantics across the schema and the request path.

This document treats the Lovable codebase as **directional inspiration**, not a starting point. We will reuse the design tokens, the shadcn component library, the React Router structure, the Supabase RLS schema patterns, and selected page concepts. We will **not** treat the existing code as production-ready, and we will rebuild the data layer, integration layer, and several of the persona models from scratch.

The architecture below is sized for Kyndryl's stated workload (300 hires/month) plus a 3x safety margin for ramp-up and bursts. That sizing is the launch-customer constraint; the architecture itself does not assume only one tenant of that volume.

---

## 1.1 Multi-tenancy as a foundational principle

Multi-tenancy is structural, not bolted-on. The defining choices:

1. **Shared database, shared schema, tenant-scoped rows.** Every domain entity carries `tenant_id`. Postgres RLS enforces tenant scoping at the database boundary; application bugs cannot leak data across tenants because the policy denies the read before the application gets a chance to mishandle it. This is the same pattern Ashby, Linear, and most modern multi-tenant SaaS use.
2. **Configuration vs customisation.** A new customer's needs are met by extending platform configuration surfaces (admin UI, tenant settings, role permissions, workflow definitions). They are *not* met by customer-specific code paths. The distinction is load-bearing — bespoke per-customer code destroys multi-tenant economics.
3. **Per-tenant integration credentials.** Workday ISU + OAuth, BGV vendor API keys, e-signature credentials, IdP SSO config, calendar OAuth tokens — all stored in `integration_credentials` rows scoped by `tenant_id`, encrypted at rest with KMS, isolated. One tenant's Workday outage cannot affect another's hire flow.
4. **Tenant onboarding is a product feature.** Inviting a new tenant, provisioning their integrations, configuring their approval matrix, registering their partners, seeding their consent text — all flows in the admin surface. The HireOps team does not ship database changes per customer.
5. **Per-tenant data residency** is acknowledged as a future need (region-per-tenant for jurisdictions that mandate local data). The data model accommodates it (a tenant's region is a tenant attribute that drives storage/compute placement), but Wave 1 ships single-region (ap-south-1, Mumbai). Multi-region tenant placement is Wave 3+ and will be revisited in the production roadmap.
6. **Configurable per-tenant defaults with platform-wide guardrails.** The platform sets safe defaults (e.g., 90-day partner ownership window, 24h triage SLA, 25% holdback). Tenants override within bounds; the bounds themselves are platform decisions.

The Multi-Tenancy ADR (forthcoming, ADR-002) elaborates the schema, the RLS policy patterns, the credential storage model, the tenant-onboarding workflow, and the operational runbooks. Treat the rest of this document as the per-tenant view of the platform until the ADR lands.

---

## 2. Principles

These are the non-negotiables that govern every architectural decision in this doc.

1. **Workday is the source of truth for employees.** HireOps is the source of truth for candidates and the recruitment process. The handoff happens at `Hire_Employee`. After that, Workday wins.
2. **Every state transition is auditable.** Every. One. DPDPA + Kyndryl audit + future-Anthropic-customer audit all demand it.
3. **Every external integration is idempotent and retriable.** Workday calls fail. BGV vendors are slow. Job boards rate-limit. Design for failure as the default.
4. **Read paths and write paths are separated where load justifies it.** Recruiter dashboards (read-heavy, can tolerate 5s staleness) do not share queries with offer creation (write-critical, must be instant).
5. **Data minimisation by design.** DPDPA principle. We do not collect what we do not need; we delete what we no longer need; we provide candidate-facing controls for both.
6. **No demo bypass in production.** Every privilege check is real. The Lovable `enterDemo()` shortcut is fine for sales demos in a separate environment — it does not exist in the production codebase path.
7. **Geography first.** India region for India workloads. PH region for PH. Architecture must support this from day one even if we deploy single-region for POC.
8. **Boring tech preferred.** This is an enterprise HR platform serving a regulated customer. We optimise for engineers who can be replaced and incidents that can be diagnosed at 2am, not for resume-driven novelty.

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         CLIENT TIER                                       │
│                                                                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐ │
│  │  Internal    │ │  Candidate   │ │  Partner     │ │  Public career  │ │
│  │  portal      │ │  portal      │ │  portal      │ │  site           │ │
│  │  (React+Vite)│ │  (React+Vite)│ │  (React+Vite)│ │  (Next.js, SSR) │ │
│  │  /app/*      │ │ /candidate/* │ │  /partner/*  │ │  careers.../... │ │
│  │  SSO (Okta/  │ │  Email/OTP/  │ │  Magic-link  │ │  No auth        │ │
│  │  AzureAD)    │ │  passwordless│ │  + MFA       │ │  (public)       │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────────┬────────┘ │
│         │                 │                 │                 │           │
└─────────┼─────────────────┼─────────────────┼─────────────────┼───────────┘
          │                 │                 │                 │
          └─────────────────┼─────────────────┼─────────────────┘
                            │                 │
                            │  HTTPS (TLS 1.3) + JWT (audience-scoped per portal)
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY / EDGE                                │
│        Cloudflare (WAF, rate limiting, DDoS, geo routing)                 │
│        Per-portal rate limits — partner portal stricter (anti-abuse)      │
└─────────────────────────┬────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────────────────┐
        │                 │                             │
        ▼                 ▼                             ▼
┌──────────────┐  ┌────────────────────┐  ┌────────────────────────────────┐
│ Auth         │  │ Application API    │  │ Workers / Async tier           │
│ - Internal:  │  │ (Node.js + Hono    │  │ (Node.js, BullMQ, Redis-backed)│
│   SSO (SAML/ │  │  + tRPC, on Fly.io │  │                                │
│   OIDC) to   │  │  or Render)        │  │  - Workday sync worker         │
│   Okta /     │  │                    │  │  - BGV poll worker             │
│   Azure AD   │  │  - tRPC procedures │  │  - Notification worker         │
│ - Candidate: │  │  - Webhook in      │  │  - Resume parsing worker       │
│   Supabase   │  │  - File uploads    │  │  - AI scoring worker           │
│   Auth       │  │  - Per-portal      │  │  - Reconciliation jobs         │
│ - Partner:   │  │    permission      │  │  - Partner email-intake parser │
│   Magic-link │  │    middleware      │  │  - Partner ownership reconciler│
│   + MFA      │  │  - Content scanner │  │  - Content-scanner worker      │
│   (separate  │  │    on partner-     │  │    (LLM-based, partner msgs)   │
│   tenant)    │  │    candidate msgs  │  │                                │
└──────┬───────┘  └─────────┬──────────┘  └──────────────┬─────────────────┘
       │                    │                             │
       └────────────────────┼─────────────────────────────┘
                            │
        ┌───────────────────┼─────────────────────┐
        ▼                   ▼                     ▼
┌──────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│ Postgres     │  │ Object storage   │  │ Search                 │
│ (managed,    │  │ (S3 / R2)        │  │ (Postgres FTS for v1,  │
│  Supabase    │  │  - resumes       │  │  Typesense / OpenSearch│
│  or Neon)    │  │  - documents     │  │  for v2)               │
│              │  │  - offer letters │  │                        │
│  - RLS       │  │  - id proofs     │  │                        │
│  - PITR      │  │  - partner-      │  │                        │
│  - Read      │  │    submitted CVs │  │                        │
│    replicas  │  │  + KMS-encrypted │  │                        │
└──────────────┘  └──────────────────┘  └────────────────────────┘
        │                   │                     │
        └───────────────────┼─────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    EXTERNAL INTEGRATIONS                                  │
│                                                                           │
│  Workday          Job boards        BGV vendor       Comms               │
│  (SOAP +REST)     (LinkedIn,        (HireRight /     (SendGrid email,    │
│                    Naukri,           FirstAdvantage)  Twilio SMS,        │
│                    Indeed)                            WhatsApp Business) │
│                                                                           │
│  Calendar         IdP / SCIM        Video            Observability       │
│  (Google,         (Okta, Azure      (Zoom, Teams)    (Sentry, PostHog,   │
│   Outlook)         AD)                                Datadog)           │
│                                                                           │
│  AI / LLM         E-signature       Storage KMS      Kyndryl AP /        │
│  (Anthropic,      (DocuSign /       (AWS KMS / GCP   Finance (partner    │
│   AWS Bedrock)     Adobe Sign)       KMS)             invoice routing)   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Why these choices (and where I diverge from Lovable)

### 4.1 Frontend

**Keep:** React + Vite + TypeScript, Tailwind, shadcn/ui, framer-motion, React Router, React Query, Zod. The Lovable choices here are good and the dependencies are mainstream.

**Change:**
- **Drop `lovable-tagger`.** Removes the Lovable-IDE coupling.
- **Add Storybook.** With 78+ pages and a multi-persona system, component documentation pays for itself in week 3.
- **Promote the candidate portal to its own bundle.** Currently it shares a build with the internal portal. They have different security postures (public-facing vs SSO-gated), different deployment cadences, and different performance characteristics. Two Vite projects, one shared `packages/ui` for the design system.
- **Add a third frontend: the public career site.** SEO-critical (Google indexes job posts). React SPA is the wrong tool. **Use Next.js with SSR** — single property, hosted separately, deep links to the candidate apply flow.
- **Add Sentry + PostHog from day one.**

### 4.2 Backend

**Diverge from Lovable significantly.** Lovable runs everything through Supabase (Postgres + Auth + Edge Functions). For Kyndryl scale and integration complexity, this is not enough.

**The split:**

| Concern | Where it lives | Why |
|---|---|---|
| Database | Postgres (Supabase or Neon, in ap-south-1) | RLS, PITR, replicas, mature ecosystem. Lovable made the right call here. |
| Auth | Supabase Auth (candidates) + SSO bridge to Okta/Azure AD (internal) | Supabase Auth is fine for candidate sign-up. Internal users must SSO; Supabase Auth supports SAML/OIDC. |
| Application API | **Custom Node.js service**, not Supabase Edge Functions | Edge Functions time out at 60–150s and are unsuitable for Workday SOAP roundtrips, large file uploads, or bulk operations. Run Hono + tRPC on Fly.io / Render / Cloud Run. |
| Async work | BullMQ on Redis | Workday syncs, BGV polling, notifications, resume parsing — all queue-based. Edge Functions cannot do this. |
| File storage | S3 / Cloudflare R2 with KMS-encrypted PII | Supabase Storage is OK for v1, but for PII at scale, S3 + KMS gives us proper field-level key management. |
| Search | Postgres FTS for v1, Typesense for v2 | Defer Elasticsearch complexity until volume justifies. |
| AI / LLM | Anthropic API (Claude) for primary; AWS Bedrock as fallback | **Drop the Lovable AI Gateway dependency.** Direct vendor calls. Token usage logged to `ai_usage_logs`. |

### 4.3 Why not stay all-Supabase?

I want to be explicit about this because it is the biggest architectural divergence from Lovable.

Supabase Edge Functions are excellent for: short auth flows, OTP send/verify, webhooks under 30s, lightweight LLM calls. They are the wrong tool for:

- **Workday SOAP calls** — these can take 30–120 seconds, sometimes more under load. Edge Function timeout will trigger silent failures.
- **Bulk operations** — moving 200 candidates through stages, fanning out 200 emails, syncing 50 records to Workday — all need queues, retries, and observability that Edge Functions don't provide.
- **Long-running reconciliation** — nightly "compare HireOps hires to Workday workers and fix drift" needs hours, not seconds.
- **File processing** — resume parsing, OCR, PDF generation for offer letters — memory-heavy and time-variable.
- **AI scoring at volume** — 500 candidates × 8 seconds per scoring call = 4000s of compute, even with parallelism. Belongs in a worker, not an HTTP handler.

The right pattern is: **Supabase for the data and RLS, custom Node service for the API surface, BullMQ workers for everything async.** This is boring, mainstream, debuggable, and well-known to any senior engineer Kyndryl might want to staff against the platform later.

---

## 5. Data architecture

### 5.1 Data model — extending Lovable's schema

Lovable's 45-table schema is a decent foundation for the **recruitment** half. It needs significant additions for onboarding and offboarding, plus restructuring of a few tables.

**Tables to keep largely as-is:** `profiles`, `user_roles`, `requisitions`, `jobs`, `applications`, `interviews`, `interview_feedback`, `interview_summaries`, `interview_plans`, `offers`, `offer_recommendations`, `jd_versions`, `jd_skills`, `bias_rules`, `audit_logs`, `notifications`, `ai_usage_logs`, `kb_articles`, `whatsapp_*`, `messaging_providers`, `workflows`, `workflow_runs`.

**Note: partner submissions are NOT a separate table.** They use the existing `applications` table with three new columns: `source_partner_id` (FK to `partner_orgs`, nullable for direct applications), `submitted_by_partner_user_id` (FK to `partner_users`, nullable), and `partner_submission_metadata` (JSONB carrying partner-side context such as the consent attestation timestamp and the partner-supplied recruiter note). The "submission" verb is informal language used in `partner-wireflows.md`; the canonical table is `applications`.

**Tables to restructure:**

- `candidates` — split into `candidates` (recruitment-side identity) and `employees` (post-hire). They share a `person_id` foreign key. This is critical for DPDPA: a candidate has different consent than an employee, and an alumni has different retention than either.
- `integrations` — currently a stubbed display-only table. Replace with `integration_credentials` (encrypted), `integration_endpoints`, `integration_runs` (a log of every sync), `integration_failures` (with retry state).
- `hr_cases` — extend to a polymorphic `cases` table with `case_type` enum: `recruitment`, `onboarding`, `offboarding`, `disciplinary`, etc. Or split per-type. I lean toward separate tables — they have very different fields.

**New tables required:**

```
-- Identity & lifecycle
persons                         -- canonical person ID across candidate→employee→alumni
employees                       -- post-hire record, links to Workday Worker ID
employee_history                -- promotion, transfer, manager-change events

-- Position & headcount
positions                       -- Workday-mirrored position records
headcount_envelopes             -- approved hiring budget by org/period
position_assignments            -- which person occupies which position when

-- Recruitment core (extension)
requisition_knockouts           -- (id, req_id FK→requisitions, question_text TEXT,
                                --  type ENUM('boolean','numeric_min','numeric_max','enum'),
                                --  threshold_value JSONB,
                                --  source ENUM('parsed_cv','candidate_asserted','partner_asserted'),
                                --  order_index INT)
                                -- Gates submission validity per requirements.md §5.4

-- Onboarding
onboarding_cases                -- one per new hire
onboarding_tasks                -- atomic tasks (collect doc, IT provision, training, etc.)
document_types                  -- (id, code TEXT UNIQUE, name TEXT, geography_code CHAR(2),
                                --  required_for_lifecycle_stage TEXT, retention_years INT)
                                -- Drives onboarding_documents.document_type_id FK and
                                -- per-geography filtering. Cross-references requirements.md §7.1.
onboarding_documents            -- KMS-encrypted document blob metadata; FK document_type_id → document_types
bgv_runs                        -- BGV vendor coordination
bgv_results                     -- vendor outcomes
it_provisioning_requests        -- handoff to IT persona
asset_assignments               -- laptop, peripherals, badge

-- Offboarding
offboarding_cases               -- one per resignation/termination
offboarding_tasks               -- atomic tasks (KT, asset return, F&F, etc.)
exit_interviews                 -- structured + free text
asset_returns
final_settlements               -- F&F calculation rows

-- Compliance
consents                        -- DPDPA consent records, 7-year retention
data_principal_requests         -- access/correction/erasure requests
data_retention_schedules        -- per-data-category retention rules
pii_access_log                  -- every PII read, who/when/why

-- Workday sync state
workday_sync_jobs               -- one row per sync attempt
workday_worker_links            -- HireOps person_id ↔ Workday worker_wid
workday_position_links          -- HireOps position_id ↔ Workday position_wid
workday_reconciliation_runs

-- Approval framework (generalised)
approval_chains                 -- definition of approval hierarchy per type
approval_requests               -- (Lovable has this — extend)
approval_decisions

-- Notification framework (generalised)
notification_templates          -- (Lovable has whatsapp_templates — extend)
notification_dispatches         -- log of every send
notification_preferences        -- per-user channel preferences

-- Search / indexing
search_documents                -- denormalised tsvector index
```

### 5.2 Why split candidates and employees

DPDPA legal basis is different. A candidate has consent; an employee has legitimate-interest grounds (employment contract). Retention rules differ. Permissions differ. RLS policies differ. Treating them as one row with a "stage" enum (as Lovable does) bakes in long-term pain — every query needs the stage filter, every audit needs to disambiguate, every consent question requires looking up the role.

Solution: a `persons` table with stable identity, joined to `candidates` for active recruitment, `employees` for active employment, and `alumni` for post-employment retention. One identity, multiple lifecycle records, clean retention semantics.

### 5.3 Indexing & query strategy at 300/month

Volume math:
- 1 year of operation: ~110,000 candidates, ~20,000 interviews, ~3,600 employees, ~600 offboarding cases.
- 5 years of operation: ~550,000 candidates (retention may purge most), ~100,000 interviews, ~18,000 employees.

This is **comfortably small** for Postgres in absolute terms. But the access patterns matter:

| Access pattern | Strategy |
|---|---|
| Recruiter pipeline view (filter by req + stage + score) | Composite index `(requisition_id, stage, ai_score DESC)`. Server-side pagination. |
| Candidate full-text search | tsvector column on candidates, GIN index. PG FTS is sufficient until 500k rows. |
| Manager's open candidates | Index `(hiring_manager_id, stage)` partial WHERE `stage NOT IN (rejected, hired)`. |
| Audit log queries | Time-range + actor partial indexes; partition by month after Year 1. |
| Workday sync status | Index `(workday_sync_status, last_sync_at)` for reconciliation queries. |
| Bulk operations | Use `WHERE id = ANY($1)` with indexed PK — Postgres handles this fine up to ~10k IDs. |

Rule: **measure first, index second.** Lovable has zero indexes documented. We add a `migrations/indexes/` discipline and benchmark every page's main query.

### 5.4 Read replicas + caching

For 300/month, a single Postgres primary handles writes comfortably. Reads go to a replica for: dashboard aggregates, analytics queries, full-text search.

Cache layer (Redis):
- Session state (in addition to JWT)
- Frequently-read config (role permissions, approval matrices, integration endpoints)
- Computed aggregates with TTL (recruiter dashboard KPIs, refreshed every 5 min)
- BullMQ queues

### 5.5 Backups & disaster recovery

- Postgres PITR with 30-day retention
- Daily logical backups to a separate region
- S3 bucket cross-region replication for documents
- DR drill quarterly: restore-to-staging from backup, verify <4h RTO, <15min RPO

---

## 6. The Workday integration — most important section in this doc

This is the make-or-break part of the POC. Detailed design.

### 6.1 What we sync, when, and how

| Object | Direction | Trigger | API | Frequency |
|---|---|---|---|---|
| Organisations (depts, cost centres, locations) | WD → HireOps | Daily snapshot | REST + WQL | Nightly batch |
| Job profiles | WD → HireOps | On change | REST + WQL | Hourly poll. Workday does not natively support outbound webhooks for HR data changes; see `workday-adr.md` §1. |
| Positions | WD → HireOps | On position lifecycle event | SOAP `Get_Positions` + REST | 15-min poll. Workday does not natively support outbound webhooks for HR data changes; see `workday-adr.md` §1. Third-party "virtual webhook" vendors (Knit, Merge) poll on customer's behalf — out of scope for POC. |
| Pre-Hire | HireOps → WD | Offer accepted | SOAP `Put_Applicant` | Real-time, queued |
| Hire | HireOps → WD | Day 1 of new hire | SOAP `Hire_Employee` (or `Import_Hire_Employee` for batch) | Real-time, queued |
| Worker reads | WD → HireOps on demand | Manager view, payroll, etc. | REST `/workers/{id}` | Real-time |
| Worker updates (post-hire data corrections) | Bidirectional | On change | SOAP `Edit_Position_Restrictions`, `Change_Job` | Queued |
| Termination | HireOps → WD | Last working day | SOAP `Terminate_Employee` | Real-time, queued |

### 6.2 Implementation pattern — the integration worker

A dedicated Node.js worker process. Stateless. Multiple replicas behind BullMQ. **This is not an Edge Function.**

```
                       ┌──────────────────────────────────┐
                       │   workday-sync-worker (replicas) │
                       │                                  │
   BullMQ job arrives  │   1. Fetch sync intent from PG   │
        ───────────►   │   2. Build SOAP/REST payload     │
                       │   3. Sign + send to Workday      │
                       │   4. Parse response              │
                       │   5. Update sync_jobs row        │
                       │   6. Emit success/failure event  │
                       │   7. On failure: backoff + retry │
                       │   8. On 3rd failure: dead-letter │
                       └──────────────────────────────────┘
                                      │
                                      ▼
                       ┌──────────────────────────────────┐
                       │   Workday tenant                 │
                       │   - SOAP endpoint                │
                       │   - REST endpoint                │
                       │   - ISU credentials (rotated 90d)│
                       └──────────────────────────────────┘
```

Idempotency: every sync job has a `business_key` (e.g., `hire:{candidate_id}:{position_id}`) that Workday already-received-this-key checks against. We do not double-hire.

Reconciliation: a daily job compares HireOps state to Workday state. Surfaces drift in `AdminIntegrations` health view.

### 6.3 Auth & credential management

- Workday ISU (Integration System User) for SOAP — stored in AWS Secrets Manager / Vault. Never in `.env`.
- OAuth 2.0 client for REST + WQL — refresh tokens stored in Vault, rotated 90 days.
- Separate creds for sandbox, staging, production tenants.
- Lovable has none of this. Currently the schema has an `integrations` table that is a UI mock. We replace it.

### 6.4 Failure modes & responses

| Failure | Detection | Response |
|---|---|---|
| Network timeout | 30s-cap on call | Retry with exponential backoff (5 attempts: 1s, 5s, 30s, 2min, 10min). After: dead-letter + page on-call. |
| Workday auth expired | 401 response | Auto-refresh OAuth token; if refresh fails, page on-call. |
| Validation error from WD | 400 / SOAP fault | Mark job as `requires_human`, surface in admin queue with parsed error reason. Do not retry. |
| Workday throttling | 429 / SOAP throttle | Respect Retry-After; queue back-pressure. |
| Workday major incident | 503 | Pause the queue; alert on-call; resume on health check. |
| Payload schema mismatch (WD upgraded) | Parse error | Block deploys; engineering ticket; schema regen. |

### 6.5 Volume sizing for Workday sync

At 300 hires/month:
- ~10 hires/day average → 10 `Hire_Employee` calls/day, with peaks ~50/day at month-end.
- ~10 terminations/month → trivial.
- Position polling: ~50–500 positions per Kyndryl GCC, 15-min poll = 96 polls/day = trivial.
- Hourly job-profile sync: ~24 calls/day = trivial.

This is well within Workday API rate limits. The bottleneck is not throughput; it is **correctness** — every sync must succeed-or-fail-cleanly with no silent corruption.

### 6.6 Why not use Workato / Mulesoft / Boomi as middleware?

I considered this. Pros: Workday-approved connectors, no code, faster to ship integration. Cons:
- Adds a $30k–$80k/year tool to the cost stack
- Adds a vendor relationship Kyndryl may want to negotiate separately
- Slower iteration loop than custom code (changing a transform = JIRA ticket to middleware team)
- Locks us out of complex transformations we will inevitably need

For POC, **custom code wins**. If at scale we find the integration burden is unsustainable, swapping in Workato later is a refactor, not a rewrite.

---

## 7. HR Partner architecture — second-most-important section

After Workday, this is the riskiest and most distinctive subsystem in HireOps. Get it wrong and Kyndryl pays double placement fees, partners sue, and the platform becomes unusable for the channel that supplies most of its candidates.

### 7.1 The architectural problem

The partner subsystem combines five hard problems that don't normally coexist in one place:

1. **External-tenant authentication** — partners are not Kyndryl employees, cannot SSO via Kyndryl IdP, but must have strong-enough auth to be commercially trusted with candidate data.
2. **Strict data scoping** — every query a partner makes must be filtered down to "only your organisation's candidates." A single missing RLS policy is a P0 data breach.
3. **A consensus state machine** for candidate ownership across competing parties, with millisecond-resolution conflict resolution.
4. **Content monitoring** of partner-to-candidate communication without violating either party's reasonable expectations.
5. **Commercial accuracy** at the level required for invoice generation and dispute resolution against signed contracts.

Each of these is its own subsystem. The architecture below addresses them as separable concerns.

### 7.2 Auth architecture for partners

**Separate auth domain from internal users and from candidates.** Partners are their own tenant.

| Element | Choice |
|---|---|
| Identity provider | Supabase Auth in a separate project, or a separate Auth0/Clerk tenant. **Not the same tenant as candidates** — different threat model, different data access, different audit requirements. |
| Login method | Magic-link (email-based, expires in 15 min) + MFA (TOTP or SMS). Password support optional and discouraged. |
| Account provisioning | Three-tier: Kyndryl admin invites a partner organisation → partner-org-admin accepts and gets login → partner-org-admin invites their own recruiters within their org. SCIM not required for POC. |
| Session | Short-lived JWT (1h), refresh token (7 days, rotating). Audience-scoped: the `aud` claim is `partner-portal`, distinct from `internal-portal` and `candidate-portal`. Cross-portal token reuse is impossible. |
| MFA enforcement | Mandatory for all partner accounts. No grace period. |
| Account lockout | After 5 failed login attempts, 15-min lockout. Notify partner-org-admin. |
| Inactive expiry | 90 days no-login → account suspended, requires re-invite. |
| Termination | Kyndryl admin can revoke a partner organisation in one click — cascades to all users in that org, immediate. |

### 7.3 Data scoping & RLS

Every partner-touching table has RLS policies that combine **organisation-membership** and **ownership-of-record**:

```sql
-- Example: partners can only see their own candidate submissions

CREATE POLICY "partners view own submissions"
  ON public.candidates FOR SELECT
  TO authenticated
  USING (
    -- Internal users: existing roles
    has_role(auth.uid(), 'recruiter')
    OR has_role(auth.uid(), 'admin')
    OR has_role(auth.uid(), 'hr_team')

    -- Partner users: only candidates they submitted, only if their org is active
    OR (
      has_role(auth.uid(), 'partner')
      AND source_partner_id = (
        SELECT partner_org_id FROM partner_users
        WHERE user_id = auth.uid() AND status = 'active'
      )
    )

    -- Candidates: only their own record
    OR (auth.uid() = user_id)
  );
```

Equivalent policies on every partner-readable table: `applications`, `interviews` (heavily redacted view), `offers` (status only, no comp details), `notifications`. Lovable's RLS pattern translates here, but the policies themselves are net-new.

Crucially, partners **never** see internal feedback, scoring rationale, or other partners' submissions. The default RLS on these tables denies; specific allow-policies are added only for explicit partner-readable views.

### 7.4 The candidate ownership state machine

This is the most architecturally novel part of the system. State lives in two tables:

```sql
CREATE TABLE candidate_ownership_claims (
  id UUID PRIMARY KEY,
  person_id UUID REFERENCES persons(id),    -- canonical person
  partner_org_id UUID REFERENCES partner_orgs(id),
  requisition_id UUID REFERENCES requisitions(id) NULL,  -- null for speculative
  claimed_at TIMESTAMPTZ NOT NULL,           -- millisecond-resolution
  expires_at TIMESTAMPTZ NOT NULL,           -- claimed_at + 90 days
  status TEXT NOT NULL,                       -- active, expired, voided, transferred
  voided_reason TEXT NULL,
  evidence JSONB NOT NULL                    -- submission record snapshot
);

CREATE UNIQUE INDEX one_active_claim_per_person_per_req
  ON candidate_ownership_claims (person_id, requisition_id)
  WHERE status = 'active';

CREATE TABLE candidate_dedup_attempts (
  id UUID PRIMARY KEY,
  attempted_at TIMESTAMPTZ NOT NULL,
  attempted_by_partner_org_id UUID NULL,     -- null if direct application
  contact_email TEXT NULL,
  contact_phone TEXT NULL,
  resume_hash TEXT NULL,
  resolved_to_person_id UUID NULL,
  outcome TEXT NOT NULL,                      -- accepted, rejected_duplicate, rejected_invalid
  rejection_reason TEXT NULL
);
```

The unique partial index on `(person_id, requisition_id) WHERE status = 'active'` is the database-level guarantee that **two partners cannot simultaneously own the same candidate for the same req**. Postgres rejects the second insert. The application layer handles this gracefully — the loser's submission goes to `candidate_dedup_attempts` for audit, with reason `rejected_duplicate`.

### 7.5 Submission flow

Step-by-step, in order, with system actions:

```
1. Partner uploads CV via portal (or sends email for ad-hoc).
   ↓
2. Resume parser extracts: name, email, phone, skills, experience.
   (LLM-assisted; Haiku for speed and cost; structured JSON output)
   ↓
3. Dedup check (atomic):
   ├─ Hash CV content + normalise email + normalise phone
   ├─ Query persons table: existing match?
   │  ├─ Yes → check active ownership claim
   │  │  ├─ Active claim exists → REJECT submission, log to dedup_attempts
   │  │  └─ No active claim → proceed, create new claim, link to existing person
   │  └─ No → create new person record, create new claim
   ↓
4. Validation:
   ├─ DPDPA consent attestation present? → if no, REJECT
   ├─ Submitting partner empanelled for this req? → if no, REJECT
   ├─ Required fields populated? → if no, route to "missing info" queue
   ↓
5. Single transaction inserts a row into `applications` with `source_partner_id` set,
   plus a `candidate_ownership_claims` row, plus a `consents` row. (`candidates` row
   created earlier in step 3 if no existing person.) Note: there is no separate
   `submissions` table — partner submissions are `applications` rows tagged with the
   partner FKs. Transaction commits or rolls back atomically. No half-states.
   ↓
6. Async: notify Kyndryl recruiter assigned to this req.
   Async: send confirmation to partner.
   Async: queue for AI scoring.
```

The atomicity is critical. A submission is a single transaction that either fully succeeds or fully fails. There is no "candidate created but ownership not claimed" state.

### 7.6 Edge case implementation

The edge cases described in the requirements doc map directly to code:

| Scenario | Implementation |
|---|---|
| Two partners submit same candidate within seconds | Postgres `INSERT ... ON CONFLICT (person_id, requisition_id) WHERE status = 'active' DO NOTHING RETURNING id` — winner gets the claim, loser gets nothing back, application code routes loser to dedup_attempts table. |
| Direct application before partner submission | Direct application creates `person` record without an ownership claim. Subsequent partner submissions hit the dedup check, find an existing person, and are rejected with reason `direct_application_exists`. |
| Disputed ownership | Manual override endpoint requires admin role + reason. Logs old claim → voided → new claim issued, with full audit trail. |
| Cross-req ownership | Single query: "is there ANY active claim for this person across ANY req from the same partner org" — if yes, the partner has standing to claim a hire on a different req under most MSA terms. Surfaced in commercial dashboard. |
| Claim expiry | Nightly job: `UPDATE claims SET status = 'expired' WHERE expires_at < now() AND status = 'active'`. Notifies partner. |

### 7.7 Communication architecture (partner ↔ candidate)

This is the highest-risk partner surface — partners can use it to poach the candidate, present competing offers, or extract personal contact info. We need **logged, monitored, rate-limited** communication that doesn't feel adversarial to the partner.

Architecture:

```
Partner sends message via portal
  ↓
API: validate sender is the candidate's owning partner
  ↓
Async: enqueue to content-scanner worker
  ↓
Content scanner (Haiku LLM with structured output):
  ├─ Detects: alternative job mentions, competitor names,
  │           personal email/phone requests, derogatory references,
  │           non-Kyndryl meeting links
  ├─ Verdict: clean / soft-warn / hard-block
  ↓
If clean → deliver to candidate (in-app + email notification)
If soft-warn → deliver, flag for admin review
If hard-block → do NOT deliver, notify partner with policy reference,
               flag for admin review, count toward partner-violation strikes
  ↓
Audit: every message stored encrypted, retained 7 years per DPDPA.
```

The content scanner is **not** acting as a censor of legitimate communication — it's a violation-detection mechanism. Most messages pass clean. False positives are reviewed and the policy refined.

Rate limits: partners are capped at 5 messages per candidate per day, 50 messages per partner-recruiter per day. Bulk-messaging primitives are not exposed to partners.

### 7.8 Commercials & invoice flow

Architecture:

```sql
CREATE TABLE partner_msa (
  partner_org_id UUID PRIMARY KEY,
  tier TEXT NOT NULL,                        -- 'empanelled' | 'ad_hoc'
  fee_structure TEXT NOT NULL,               -- 'percentage_ctc' | 'flat_per_grade' | 'flat_per_hire'
  fee_rate JSONB NOT NULL,                   -- structured per fee structure
  exclusivity_window_days INT NOT NULL DEFAULT 90,    -- 90 empanelled / 60 ad-hoc / 180 speculative
  exclusivity_scope TEXT NOT NULL,           -- 'req_only' | 'org_wide' (default 'org_wide')
  probation_holdback_days INT NOT NULL DEFAULT 90,
  probation_holdback_pct NUMERIC NOT NULL,   -- e.g. 25.00 = 25% (Wave 1 default for empanelled);
                                             -- ad-hoc rows have probation_holdback_pct = 0
  replacement_guarantee_days INT NOT NULL DEFAULT 90,
  replacement_mode TEXT NOT NULL DEFAULT 'clawback_only',
                                             -- 'clawback_only' | 'free_replacement' | 'hybrid'
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  signed_msa_url TEXT NULL                   -- pointer to KMS-encrypted contract;
                                             -- NULL for ad-hoc tier (no MSA)
);

-- Ad-hoc partners share this table with tier='ad_hoc'. Seed defaults for ad-hoc rows:
-- fee_structure='flat_per_hire', probation_holdback_pct=0, replacement_mode='clawback_only',
-- exclusivity_window_days=60, signed_msa_url=NULL. See requirements.md §6.5 and §6.4.

CREATE TABLE partner_fees (
  id UUID PRIMARY KEY,
  partner_org_id UUID REFERENCES partner_orgs(id),
  hire_id UUID REFERENCES employees(id),
  ownership_claim_id UUID REFERENCES candidate_ownership_claims(id),
  msa_snapshot JSONB NOT NULL,               -- copy of MSA terms at hire date
  total_fee_amount NUMERIC NOT NULL,
  initial_invoice_amount NUMERIC NOT NULL,   -- payable on Day 1
  probation_invoice_amount NUMERIC NOT NULL, -- payable on probation pass
  status TEXT NOT NULL,                       -- pending, partial_invoiced, fully_invoiced, paid, disputed, clawback
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ NULL
);
```

The `msa_snapshot` field is critical — MSAs change over time, but a fee record must always reflect the terms in force at hire date. Snapshot at fee-creation, never join to `partner_msa` for amounts.

Invoice generation is partner-initiated from their portal. The system pre-fills the invoice with the calculated amount and supporting evidence. The partner submits via PDF generation (DocuSign-signed if Kyndryl AP requires) routed to Kyndryl's existing AP system (SAP/Oracle/Coupa — depends on Kyndryl's AP stack).

### 7.9 Email-intake parser for ad-hoc partners

A separate worker process subscribes to per-req email aliases:

```
cvs-{req-id}@kyndryl-hireops.com  →  routed to S3 bucket via SES (or equivalent)
cvs-talent-pool@kyndryl-hireops.com  →  S3 event triggers parser worker
                                       → Worker:
                                         ├─ Identify partner from sender domain
                                         │  (lookup against ad_hoc_partners.registered_domains)
                                         ├─ Extract attachments
                                         ├─ Parse CVs (PDF/DOC/DOCX/IMG with OCR)
                                         ├─ Extract subject/body for candidate name + consent language
                                         ├─ Run dedup check (same as portal flow)
                                         ├─ Create candidate + ad-hoc ownership claim
                                         │  (60-day window per requirements.md §6.4)
                                         └─ Send acknowledgement email back
```

**Per-req aliases are the routing mechanism; sender-domain lookup is the partner attribution mechanism.** This matches `requirements.md` §6.5 and `partner-wireflows.md` §4.2. Each open req gets a `cvs-{req-id}@…` alias auto-generated at posting time and auto-expired at req close. Speculative ad-hoc submissions go to the single `cvs-talent-pool@…` alias. The sender-domain → partner mapping is configured by Kyndryl admin via the ad-hoc registration flow (`partner-wireflows.md` §5.1).

Failure handling: emails that can't be parsed (corrupted PDFs, unintelligible content, no contact info) route to a "needs human review" queue surfaced to recruiters. They are never silently dropped.

### 7.10 Performance considerations for partner portal

At 5,000+ partner-side submissions per month across 20-30 partners, the partner portal sees serious read traffic. Optimisations:

- Partner dashboard queries cached per-partner-user with 5-minute TTL
- Pipeline view paginated with server-side filtering (no client-side filtering of large lists)
- Submission rate limited per partner-recruiter (10 submissions per minute) to prevent accidental spam from bulk-upload bugs
- Resume parsing offloaded to async queue — partner sees "submission received, processing" within 2s, full record visible within 30s
- Partner-side analytics computed nightly into materialised views, not real-time

### 7.11 Threat model specific to partner portal

| Threat | Mitigation |
|---|---|
| Partner credentials stolen → competitor accesses candidate data | MFA mandatory; short-lived tokens; suspicious-location detection (login from new country prompts re-auth); audit alerts to partner-org-admin on unusual activity |
| Compromised partner uploads malware via CV | All uploads scanned by ClamAV + sandboxed parsing; no executable file types accepted |
| Partner attempts SQL injection via CV content | Parameterised queries everywhere; no dynamic SQL; LLM-extracted content treated as untrusted user input |
| Partner submits scraped LinkedIn profiles without consent | DPDPA consent attestation required at submission; spot audits by Kyndryl admin; partner panel review on consent quality complaints |
| Partner enumerates internal Kyndryl users via timing attacks on submission flow | All errors return generic messages; no information leakage about whether a person already exists, only that the submission was rejected |
| Partner uses platform to poach candidate to a competing employer | Content scanner; outbound message volume monitoring; stop-words list; admin review of flagged messages |
| Partner submits the same candidate to multiple reqs hoping for double fees | Database-level uniqueness on `(person_id, partner_org_id)` for active claims prevents this; cross-req fee logic surfaces the conflict to admin |
| Partner-org-admin invites unauthorised users to their org | All partner-user invites require email verification; partner-org-admin actions are audited and visible to Kyndryl admin |

### 7.12 Why this architecture is not optional

Some architectures here look heavy for a POC. They are not. Specifically:

- **The unique partial index on ownership claims** prevents simultaneous claims at the database level. Without it, the application layer would have to enforce uniqueness via locks, which fails under concurrency. We've all seen that bug.
- **The MSA snapshot in fee records** prevents historical fee disputes. Without it, every MSA edit retroactively changes fees already accrued. Partners will sue.
- **Separate auth tenant for partners** prevents a candidate-side data breach from cascading into partner data and vice versa.
- **Content scanner on partner messages** is the difference between Kyndryl trusting the platform with partners and not. Without it, the first poaching incident kills the channel.

These are foundational. They cannot be retrofitted in Wave 2. They have to ship in Wave 1, alongside the basic portal.

---

## 8. Other integrations

### 8.1 BGV vendor

| Vendor | Why considered | Notes |
|---|---|---|
| HireRight | Global, Kyndryl likely already has a contract | Default if Kyndryl already uses |
| FirstAdvantage | India-strong, large GCC presence | Strong India option |
| AuthBridge | India-only, very fast | India POC short-list |

Pattern: HireOps initiates a BGV check with candidate + role context, vendor processes (1–10 days), webhook back with verification report. Status surfaces in onboarding case.

**Webhook authentication and isolation.** Inbound vendor webhooks are authenticated via HMAC-SHA256 of the request body using a shared secret stored in Vault per environment per vendor. IP allowlisting is scoped per environment (sandbox / staging / production) and configured at the Cloudflare WAF tier. Vendor-specific SDK or REST bindings are deferred until §17 Q9 (vendor selection) is answered; the integration interface lives behind a `packages/bgv-client` (to be created) so switching vendors is a config change rather than a refactor.

### 8.2 Job boards

| Board | Geography | Integration |
|---|---|---|
| LinkedIn | Global | LinkedIn Recruiter System Connect (RSC) — official partnership tier |
| Naukri | India | Naukri RMS / API |
| Indeed | Global | Indeed Apply API |
| Kyndryl careers site | Global | Direct (we run it) |

Outbound: post a job. Inbound: receive applications via webhook or polling. Each application creates a `candidates` + `applications` record, deduplicated against existing person.

### 8.3 Calendar & video

- Google Calendar API + Microsoft Graph (Outlook). Two-way sync.
- Zoom + Teams via OAuth. Create meeting → return join URL → embed in candidate notification.
- **No custom WebRTC build.** The Lovable interview rooms are placeholder UI; we replace with Zoom/Teams embeds.

### 8.4 IdP / SCIM

- Internal users SSO via Okta / Azure AD (whichever Kyndryl uses).
- Onboarding fires SCIM provision to Okta → Okta provisions downstream apps.
- Offboarding fires SCIM deprovision → Okta cascades.

### 8.5 Notifications

- **Email:** SendGrid (Lovable already mentions). Transactional only, no marketing.
- **SMS:** Twilio.
- **WhatsApp Business API:** Twilio or 360dialog. Lovable has scaffolding.
- **Push:** Firebase / OneSignal — only if/when we ship a mobile experience.

### 8.6 LLM / AI

- **Primary:** Anthropic Claude API for JD generation, candidate scoring, interview summaries, chatbot.
- **Fallback:** AWS Bedrock if Kyndryl wants in-AWS data flow.
- **Token usage tracked per feature** in `ai_usage_logs` (already in Lovable schema). Budget per feature, alert on overage.
- **Drop the Lovable AI Gateway.** Direct vendor calls, our own rate limit, our own observability.

### 8.7 E-signature

DocuSign or Adobe Sign. Generate offer PDF → kick off envelope → webhook on signature → mark offer as accepted → trigger Workday Pre-Hire creation.

---

## 9. Security architecture

### 9.1 Identity

| User type | Auth method | MFA |
|---|---|---|
| Internal users (recruiter, HM, panel, HR Ops, IT, admin) | SSO (SAML / OIDC) via Kyndryl IdP | Mandatory, IdP-enforced |
| Hiring Approver Chain | SSO (SAML / OIDC) via Kyndryl IdP. Lightweight inbox view inside `apps/internal-portal`, reachable from email deep-links. Workday-originated approvals are read back via reconciliation, not pushed (see `workday-adr.md` §1). | Mandatory, IdP-enforced |
| Candidates | Email + password OR magic link OR phone OTP | Optional |
| Employees (post-hire) | Continues SSO once provisioned | Mandatory |
| External users (BGV vendor) | API key + IP allowlist; inbound webhooks HMAC-SHA256 signed (per §8.1) | n/a — service account |
| API integrations | OAuth 2.0 client credentials or signed JWT | n/a |

The Lovable demo bypass is removed entirely from the production build via build flag. It can stay in a separate sales-demo environment.

### 9.2 Authorisation

- RBAC: role enum on user (Lovable already has `app_role` enum — extend with new personas)
- ABAC: row-level policies on candidates, requisitions, etc. Lovable's RLS is a good start; we audit and harden.
- Specific rules:
  - Recruiter sees candidates only for reqs they are assigned to
  - HM sees candidates only for reqs they own
  - Panel sees only candidates they have an upcoming/past interview with
  - People Ops sees onboarding cases for their region/function
  - Admin sees everything but every PII access is logged

### 9.3 Data protection

| Layer | Technique |
|---|---|
| Transport | TLS 1.3 everywhere, HSTS, certificate pinning for mobile (when applicable) |
| At rest (Postgres) | Native encryption (TDE) plus column-level encryption for high-PII fields (Aadhaar, SSN, PAN, bank account) using AWS KMS + pgcrypto |
| Object storage (S3) | SSE-KMS with per-customer-tenant keys |
| Secrets | AWS Secrets Manager / HashiCorp Vault — never in `.env` files in repo |
| Logs | PII redacted at write time; secondary scrubber on read |
| Backups | Encrypted, separate KMS key |

### 9.4 Audit & monitoring

- Every PII access logged to `pii_access_log` with actor, target, reason
- Every state transition logged to `audit_logs`
- 7-year retention for both per DPDPA + Kyndryl policy expectation
- SIEM forwarding (syslog → Kyndryl SOC) — required for production
- Anomaly detection: alert on unusual access patterns (e.g., recruiter pulls 500 candidate records in 5 minutes)

### 9.5 Vulnerability management

- Dependabot + npm audit on every PR
- Snyk or equivalent for SAST
- Penetration test before production (week 22)
- Bug bounty programme (post-launch)
- Patch SLA: critical = 24h, high = 7 days, medium = 30 days

---

## 10. DPDPA compliance — built into the architecture

The Lovable codebase has zero DPDPA awareness. We engineer it in from day one.

### 10.1 Consent

- Every candidate signup includes explicit, unbundled consent: "process this application" + optional "include me in talent pool for 24 months."
- Withdrawal is one click in candidate settings; cascades to retention cleanup.
- All consents logged to `consents` with timestamp, IP, version of privacy notice agreed to. Retained 7 years.

### 10.2 Data principal rights

| Right | Implementation |
|---|---|
| Access | Self-service "download my data" in candidate portal — exports JSON + ZIP of documents |
| Correction | Self-service profile edit; HR-side correction with audit |
| Erasure | Self-service deletion request; queued for review (some retention is mandatory under labour law); SLA 30 days |
| Portability | Same export as access right, in machine-readable JSON |
| Grievance | Form in candidate settings; routes to DPO email; tracked in `data_principal_requests` |
| Nominee | DPDPA-specific: candidate can nominate a representative on death/incapacity |

### 10.3 Retention

`data_retention_schedules` table defines retention per category. Examples:

- Rejected candidate (no talent-pool consent): 6 months from rejection
- Rejected candidate (talent-pool consent): 24 months, then re-prompt
- Hired candidate → employee record: per employment law (typically 7 years post-termination in India)
- Audit logs: 7 years
- Consent records: 7 years (DPDPA Rule 4)
- Interview recordings: 12 months unless flagged for dispute

A nightly job applies retention. Soft-delete first, hard-delete after 30 days for dispute resolution.

### 10.4 DPO workflow

If Kyndryl GCC volume classifies the deployment as Significant Data Fiduciary:
- DPO appointed (Indian resident)
- DPIA conducted before launch
- Quarterly compliance audits
- Breach notification mechanism: detection → DPO → DPB filing within 72h

---

## 11. Performance & capacity sizing

### 11.1 Steady-state assumptions (after ramp-up)

| Metric | Value |
|---|---|
| Concurrent internal users (peak) | 100 |
| Concurrent candidates (peak) | 500 |
| Apply submissions/hour (peak) | 200 |
| API requests/second (peak) | 50 |
| Database connections | 20 reads + 10 writes |
| Background job rate | ~500/hour |

### 11.2 Sizing for the POC

| Component | POC config | Production target |
|---|---|---|
| Frontend | CDN-served static, 2 regions | Same |
| API (internal portal) | 2 replicas × 1 vCPU × 2GB | 4 replicas × 2 vCPU × 4GB |
| API (candidate portal) | 2 replicas × 1 vCPU × 2GB | 4 replicas × 2 vCPU × 4GB |
| Workers | 3 replicas × 1 vCPU × 2GB | 6 replicas × 2 vCPU × 4GB |
| Postgres primary | 4 vCPU × 16GB × 200GB SSD | 8 vCPU × 32GB × 500GB SSD + read replica |
| Redis | 2GB | 4GB with replication |
| Search | Postgres FTS only | Typesense 2-node cluster |
| Storage | 100GB S3, 30-day backups | 1TB S3 + cross-region replication |

### 11.3 Latency targets

| Operation | P50 | P95 | P99 |
|---|---|---|---|
| Page load (internal portal) | 800ms | 1.5s | 2.5s |
| API call (read) | 120ms | 400ms | 800ms |
| API call (write) | 250ms | 800ms | 1.5s |
| Candidate apply submission | 1.5s | 3s | 5s |
| AI scoring of one candidate | 4s | 10s | 20s |
| Workday Hire sync | 5s | 30s | 90s |
| Bulk move 50 candidates | 2s | 5s | 10s |

Lovable measures none of this. We add Lighthouse + k6 + Datadog APM from week 1.

---

## 12. Deployment & environments

### 12.1 Environments

| Environment | Purpose | Data |
|---|---|---|
| Local | Developer workstation | Synthetic seed data |
| Dev | Continuous deploy of `main` | Synthetic data, refreshed nightly |
| Staging | UAT, integration testing | Anonymised production-like data |
| Demo | Sales demos, with `enterDemo()` fake auth | Synthetic data, persona-rich |
| Production | Live Kyndryl GCC | Real data |

Five environments. Demo is **separate** from prod and dev — this is where the Lovable demo path lives.

### 12.2 Deployment

- Frontend: deploy on push to `main` for dev, manual promote to staging/prod. Cloudflare Pages or Vercel.
- Backend: GitHub Actions → Docker → Fly.io / Render / Cloud Run. Blue-green for production.
- Database migrations: gated on PR review. `supabase db push` for dev/staging; manual approval + dry-run for prod.
- Feature flags: LaunchDarkly or PostHog flags. Every new feature behind a flag for safe rollout.

### 12.3 Branching

- `main` — protected, requires 2 reviews + passing CI
- Feature branches off `main`
- Hotfix branches for production issues
- No long-lived develop branch (trunk-based)

### 12.4 CI/CD

Per PR:
- Lint (ESLint)
- Typecheck (tsc)
- Unit tests (vitest)
- Integration tests against ephemeral Postgres
- Bundle size budget check
- Lighthouse CI on key pages

Per merge to main:
- Deploy to dev
- Run E2E tests (Playwright)
- Smoke tests against deployed dev

Per promotion to staging:
- Manual approval
- Full E2E suite
- Workday sandbox integration test

Per promotion to production:
- Manual approval (engineering lead)
- Database migration dry-run
- Blue-green deploy
- Smoke test
- Auto-rollback on error rate spike

### 12.5 Observability stack

- **Logs:** Datadog Logs or Better Stack
- **Metrics:** Datadog APM or Grafana Cloud
- **Errors:** Sentry
- **Product analytics:** PostHog
- **Synthetic monitoring:** Checkly or UptimeRobot
- **Real user monitoring:** Sentry RUM or Datadog RUM

Every page, every API call, every job — instrumented from week 1. This is non-negotiable; we do not bolt observability on later.

---

## 13. AI / LLM architecture

Lovable hardcodes Gemini Flash via the Lovable AI Gateway. We change this.

### 13.1 Model selection

| Use case | Primary model | Fallback | Why |
|---|---|---|---|
| JD generation | Claude Sonnet 4.6 | GPT-4o | Highest quality long-form, low hallucination |
| Resume parsing | Claude Haiku 4.5 | GPT-4o-mini | Fast, cheap, structured output |
| Candidate scoring rationale | Claude Sonnet 4.6 | GPT-4o | Quality + auditability |
| Interview summary | Claude Sonnet 4.6 | GPT-4o | Long context, accurate |
| Candidate chatbot | Claude Haiku 4.5 | Gemini Flash | Fast, conversational |
| Bias check on JD | Claude Sonnet 4.6 | n/a | Reliable rule-following |

### 13.2 Patterns

- **All LLM calls through a thin abstraction** (`packages/ai-client`) so models can be swapped without touching feature code.
- **Prompt versioning** — every prompt is in the repo with a version. A/B testing supported.
- **Structured outputs** (JSON schema enforcement) wherever a downstream system consumes the output.
- **PII redaction** before LLM call where possible (replace candidate name + contact with placeholders, restore in post-processing). Models do not need real PII to score skills.
- **Token budgets** per feature — alert if a feature spikes 3x its baseline cost.
- **Caching** for deterministic prompts (e.g., bias check on a stable JD).

### 13.3 Where AI does not go (in POC)

- **Final hire decisions.** AI scores; humans decide. DPDPA Article on automated decision-making + plain ethics.
- **Termination decisions.** Same.
- **Compensation decisions.** AI may suggest; humans approve.
- **Anything that interacts with a candidate without disclosure.** Chatbot must declare itself.

---

## 14. Migrating from the Lovable code

The user described the Lovable code as "an idea and direction." Concretely, here is what we take and what we discard.

### 14.1 Take

- Design tokens (`--navy`, `--teal`, gradients, shadows) — these become the v0 design system
- shadcn/ui component setup
- Tailwind config
- React Router structure (with the `/app` vs `/candidate` split)
- Many page concepts and persona-specific layouts
- The Supabase RLS pattern with `has_role()` SECURITY DEFINER
- The schema for `requisitions`, `applications`, `interviews`, `offers`, `audit_logs`
- The notification framework scaffolding (`whatsapp_*`, `messaging_providers`)
- Edge functions for OTP and WhatsApp send/receive (these are appropriate for Edge Functions)

### 14.2 Discard

- The demo bypass (`enterDemo()`) from production code paths
- All mock data files (`src/data/*`) — replace with real backends
- Lovable AI Gateway — replace with direct vendor calls
- `lovable-tagger` — drop entirely
- The `integrations` admin UI as built — rebuild against real connectors
- The committed `.env` and the leaked anon key in git history (rotate the key, rewrite history if practical)
- The single-repo structure — split into a monorepo with frontend / backend / workers / shared packages

### 14.3 Rebuild

- Auth (add SSO bridge)
- Data layer (React Query hooks per domain, replacing every mock import)
- Workday integration (entirely net-new)
- Onboarding & offboarding modules (entirely net-new)
- Bulk operations
- Real search
- Career site (separate Next.js app)
- Observability
- CI/CD
- DR & backups

---

## 15. Recommended team & timeline

For the 24-week scope in `requirements.md` (extended from 22 weeks to absorb partner portal in Wave 1):

| Role | Headcount | Notes |
|---|---|---|
| Engineering lead / architect | 1 | Owns this doc, technical decisions, code review gate |
| Frontend engineers | 4 | Internal portal, candidate portal, partner portal, career site (the partner portal alone is roughly 1 FE-month of work) |
| Backend engineers | 3 | API, workers, integrations |
| Workday integration specialist | 1 | Possibly contractor; SOAP/REST/EIB experience required |
| DevOps / SRE | 1 | Infra, CI/CD, observability |
| QA engineer | 1 | E2E + integration tests, UAT coordination |
| Product designer | 1 | Design system + key flows |
| Product manager | 1 | Owns requirements, Kyndryl interface, partner onboarding |
| **Total** | **13** | |

Plus Kyndryl-side: 1 sponsor, 1 HRIS lead (Workday access), 1 GCC TA lead (UAT), 1 IT lead (provisioning integration), 1 procurement/legal lead (partner MSA reviews and contract amendments).

Realistic burn at fully-loaded rates: roughly $1.4M–$2.0M for the 24-week POC, varying by location of team.

---

## 16. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Workday tenant access delayed | Medium | High | Push for sandbox access in week 1; have Kyndryl-internal Workday champion |
| Kyndryl scope creep mid-POC | High | Medium | Locked scope in `requirements.md`; change request process; phase-gate reviews |
| DPDPA compliance gaps surface late | Medium | High | DPO engaged from week 1; DPIA in week 4; external compliance review week 18 |
| 300/month volume not actually ramped | Medium | Medium | Wave 2 stress-tests at 50/month; Wave 3 confirms at full volume before declaring done |
| BGV vendor SLA worse than assumed | High | Medium | Multiple vendors evaluated; HireOps tolerates async BGV (does not block onboarding flow) |
| **Partner ownership disputes** | **High** | **High** | Industry-standard 90-day rule documented; immutable submission timestamps; audit trail for every claim; clear dispute resolution workflow with Kyndryl + partner-org-admin in the loop |
| **Partner adoption resistance** | **Medium** | **High** | Partner onboarding programme (training, white-glove migration); start with 3-5 high-volume partners in Wave 1; expand to full panel in Wave 2; existing email-intake fallback always available |
| **Partner MSA inconsistency** | **High** | **Medium** | Configurable commercial terms per partner; do not hardcode 90-day window or fee structures; legal review of edge cases (replacement guarantees, exclusivity scope) |
| LLM cost overruns | Medium | Low | Token budgets + alerts; Haiku-first defaults; prompt-cost dashboards |
| Single-region outage during POC | Low | High | Multi-AZ within region for POC; multi-region in production roadmap |
| Lovable codebase reuse turns out to be net-negative | Low | Medium | Be honest in week 2 — if rebuild beats refactor for any module, just rebuild |
| Internal team turnover during POC | Medium | High | Documentation discipline; pair programming; no single-person knowledge silos |

---

## 17. Architecture decisions and tenant-configurable choices

Each entry below names the platform decision and indicates whether the choice is platform-wide (one decision for the whole product) or tenant-configurable (each tenant picks during onboarding). Most have been resolved with defensible defaults; the platform-wide ones may revisit with growth. Two genuinely-open items remain — they involve customer-side contracts the platform vendor cannot force.

1. **Hosting region.** Platform-wide for POC. ap-south-1 (Mumbai) for India GCC; AP region for Philippines; multi-region from POC or single? — **RESOLVED:** ap-south-1 (Mumbai), single-region for POC. Per-tenant data residency is a future capability per §1.1; revisit when a tenant's compliance posture forces region-per-tenant placement.
2. **Postgres host.** Platform-wide. Supabase managed (we already have an instance) vs Neon vs RDS vs CloudSQL? Lean toward Supabase for POC, RDS/CloudSQL at scale. — **RESOLVED:** Supabase managed for POC, with the platform-default being Supabase; revisit RDS/CloudSQL when scale or compliance demands it.
3. **API runtime host.** Platform-wide. Fly.io vs Render vs Cloud Run vs Kubernetes? Lean toward Fly.io for POC simplicity. — **RESOLVED:** Fly.io as the platform default for POC.
4. **Object storage.** Platform-wide. S3 vs Cloudflare R2 vs Supabase Storage? Lean toward S3 for KMS integration. — **RESOLVED:** S3 + KMS as the platform default.
5. **LLM primary.** Tenant-configurable, with the platform default being Anthropic Claude direct as primary and Bedrock retained as fallback. Tenants can override per their data-residency posture (a tenant whose policy mandates AWS-only data flow selects Bedrock at onboarding).
6. **Career site framework.** Platform-wide. Next.js (React, familiar) vs Astro (better SEO, less JS)? Lean Next.js for team familiarity. — **RESOLVED:** Next.js with SSR (already noted in §4.1).
7. **Mobile strategy.** Platform-wide for POC. PWA only for POC (responsive web)? Native later? Defer decision to post-POC. — **RESOLVED:** PWA-quality responsive web; native deferred to post-POC.
8. **Job board partnerships.** *(Open — Wave 2; depends on the per-tenant LinkedIn/Naukri/Indeed contracts each customer holds. Platform supports each board as a first-party integration; selection is tenant-configurable.)*
9. **BGV vendor.** Tenant-configurable, with the platform default being AuthBridge for the India launch tenant; HireRight and FirstAdvantage also supported as first-party integrations. *(Selection per tenant; same as `requirements.md` §12 Q5.)*
10. **E-signature provider.** Tenant-configurable, with the platform default being DocuSign; Adobe Sign available as an alternative if the tenant already has a contract.
11. **Calendar.** Tenant-configurable, with the platform default being both Google + Outlook supported from POC (most enterprises run a mix). Tenants whose users are exclusively on one stack can disable the other to simplify onboarding.
12. **Interview platform.** Tenant-configurable, with the platform default being Zoom; Teams is a supported alternative and the integration shape is symmetric.

---

## 18. What this document is not

- It is not a project plan with dates and resources. That is a Gantt that follows scope sign-off.
- It is not a vendor selection document. The "we'll use X" calls above are recommendations; some need RFP or contract motion.
- It is not the ADR set. Each major decision deserves its own short ADR document, written as we make the call.
- It is not the design system. A separate design spec follows after Wave 1 stabilises the core flows.
- It is not final. It is a strong v0.1 designed to drive a productive conversation with Kyndryl and our own team.
