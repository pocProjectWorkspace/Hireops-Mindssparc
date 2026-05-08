# HireOps — Partner Data Model

**Status:** v1, derived from `architecture.md` §7 + `partner-wireflows.md` resolutions, May 2026. **Multi-tenancy implications applied per ADR-002 (Multi-Tenancy).**
**Companion to:** `architecture.md` §7 (partner architecture), `partner-wireflows.md` (UX), `requirements.md` §6 (rules), `multi-tenancy-adr.md` (ADR-002, tenant isolation).
**Purpose:** Consolidation point for the partner-related schema. The table set in `architecture.md` §7.4 and §7.8 is authoritative; the additional tables referenced only in `partner-wireflows.md` are defined here so the schema is complete in one place. Every table below carries `tenant_id UUID NOT NULL REFERENCES tenants(id)` per ADR-002 §5.1; every index leads with `tenant_id`; every RLS policy starts with `tenant_id = current_tenant_id()` as the outermost predicate composing with the partner-org / role scoping inside.

This document specifies columns, FKs, indexes, and a one-line RLS-policy summary per table. It does not narrate flows — those live in `architecture.md` §7 and `partner-wireflows.md`.

Conventions:

- All `id` columns are `UUID PRIMARY KEY DEFAULT gen_random_uuid()` unless noted otherwise.
- All timestamps are `TIMESTAMPTZ NOT NULL DEFAULT now()` unless noted otherwise.
- "RLS" rows summarise the partner-tenant scoping in plain English; the SQL form follows the pattern in `architecture.md` §7.3.
- "Wave 1 scope" notes which columns/indexes ship in Wave 1 vs Wave 2/3.

---

## partner_orgs

The empanelled or ad-hoc organisation that submits candidates. Tier governs all downstream behaviour (auth, fee, exclusivity).

```sql
CREATE TABLE partner_orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  tier TEXT NOT NULL,                      -- 'empanelled' | 'ad_hoc'
  status TEXT NOT NULL DEFAULT 'invited',  -- 'invited' | 'active' | 'suspended' | 'terminated'
  invited_by_user_id UUID REFERENCES profiles(id),
  region_tags TEXT[] NOT NULL DEFAULT '{}',
  function_tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ NULL,
  terminated_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_partner_orgs_tenant_tier_status ON partner_orgs (tenant_id, tier, status);
```

- **FKs:** `tenant_id` → `tenants(id)`; `invited_by_user_id` → `profiles(id)`.
- **RLS:** tenant-scoped (outermost: `tenant_id = current_tenant_id()`), then internal admins read/write all rows in their tenant; partner users read only their own row via `partner_users.partner_org_id = id` join (also tenant-scoped).
- **Wave 1 scope:** all columns ship.

## partner_users

Users belonging to a partner org. Two roles per `partner-wireflows.md` §3.12: `org_admin` and `recruiter`.

```sql
CREATE TABLE partner_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,                   -- references the partner auth tenant identity
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NULL,
  role TEXT NOT NULL,                      -- 'org_admin' | 'recruiter'
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'suspended' | 'removed'
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_partner_users_tenant_email_per_org
  ON partner_users (tenant_id, partner_org_id, email);
CREATE INDEX idx_partner_users_tenant_org_status
  ON partner_users (tenant_id, partner_org_id, status);
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id` → `partner_orgs(id)`. `user_id` references the partner auth tenant (not the customer's SSO IdP).
- **RLS:** tenant-scoped (outermost), then partner users read only rows in their own `partner_org_id`. Only `org_admin` writes.
- **Wave 1 scope:** all columns ship.

## partner_invitations

Per-invitation row carrying the signed token. Created when a Kyndryl admin invites an org-admin; created when an org-admin invites a recruiter.

```sql
CREATE TABLE partner_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_role TEXT NOT NULL,              -- 'org_admin' | 'recruiter'
  invited_by_user_id UUID NULL,            -- NULL when tenant admin invites first org-admin;
                                           -- otherwise FK to partner_users(id)
  invited_by_internal_user_id UUID NULL,   -- FK to profiles(id), set on tenant-internal-admin invites
  token_hash TEXT NOT NULL,                -- HMAC of the signed token
  expires_at TIMESTAMPTZ NOT NULL,         -- 24h from issue
  accepted_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_partner_invitations_token ON partner_invitations (token_hash);
CREATE INDEX idx_partner_invitations_tenant_org
  ON partner_invitations (tenant_id, partner_org_id, accepted_at);
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id` → `partner_orgs(id)`; `invited_by_user_id` → `partner_users(id)`; `invited_by_internal_user_id` → `profiles(id)`.
- **RLS:** Anonymous lookup only by `token_hash` for the accept-invite flow (the token itself encodes the tenant; the lookup query selects only by token and validates the tenant against the JWT after auth completes). Tenant-scoped read for internal admins and `org_admin` partner users on invitations for their own org.
- **Wave 1 scope:** all columns ship.

## partner_assignments

Which empanelled partners are assigned to which reqs. Drives the partner's "open reqs" view (`partner-wireflows.md` §3.3).

```sql
CREATE TABLE partner_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id) ON DELETE CASCADE,
  requisition_id UUID NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by_user_id UUID NOT NULL REFERENCES profiles(id),
  unassigned_at TIMESTAMPTZ NULL,
  unassigned_by_user_id UUID NULL REFERENCES profiles(id),
  status TEXT NOT NULL DEFAULT 'active'    -- 'active' | 'unassigned'
);

CREATE UNIQUE INDEX idx_partner_assignments_active
  ON partner_assignments (tenant_id, partner_org_id, requisition_id)
  WHERE status = 'active';
CREATE INDEX idx_partner_assignments_tenant_req
  ON partner_assignments (tenant_id, requisition_id, status);
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id` → `partner_orgs(id)`, `requisition_id` → `requisitions(id)`, `assigned_by_user_id` and `unassigned_by_user_id` → `profiles(id)`.
- **RLS:** tenant-scoped (outermost), then internal users read/write all rows in their tenant; partner users read only rows where `partner_org_id` matches their own.
- **Wave 1 scope:** all columns ship; ad-hoc partners do not get rows here (they're attributed by sender domain, not by req assignment).

## partner_msa

Per-org commercial terms. Now unified across empanelled and ad-hoc per the resolution in `architecture.md` §7.8 (B5). Ad-hoc rows have `tier='ad_hoc'`, `signed_msa_url=NULL`, `probation_holdback_pct=0`, `replacement_mode='clawback_only'`, `fee_structure='flat_per_hire'`, `exclusivity_window_days=60`.

```sql
CREATE TABLE partner_msa (
  partner_org_id UUID PRIMARY KEY REFERENCES partner_orgs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id),  -- denormalised from partner_orgs for index leadership;
                                                   -- enforced consistent via app layer + RLS
  tier TEXT NOT NULL,                              -- 'empanelled' | 'ad_hoc'
  fee_structure TEXT NOT NULL,                     -- 'percentage_ctc' | 'flat_per_grade' | 'flat_per_hire'
  fee_rate JSONB NOT NULL,                         -- structured per fee_structure
  exclusivity_window_days INT NOT NULL DEFAULT 90, -- 90 empanelled / 60 ad-hoc / 180 speculative override
  exclusivity_scope TEXT NOT NULL DEFAULT 'org_wide', -- 'req_only' | 'org_wide'
  probation_holdback_days INT NOT NULL DEFAULT 90,
  probation_holdback_pct NUMERIC NOT NULL DEFAULT 25.00, -- 25% Wave 1 default for empanelled; 0 for ad-hoc
  replacement_guarantee_days INT NOT NULL DEFAULT 90,
  replacement_mode TEXT NOT NULL DEFAULT 'clawback_only', -- 'clawback_only' | 'free_replacement' | 'hybrid'
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  signed_msa_url TEXT NULL                         -- KMS-encrypted contract pointer; NULL for ad-hoc
);

CREATE INDEX idx_partner_msa_tenant_tier ON partner_msa (tenant_id, tier);
```

- **FKs:** `partner_org_id` → `partner_orgs(id)`; `tenant_id` → `tenants(id)`. `tenant_id` is denormalised from `partner_orgs.tenant_id` to allow tenant-leading indexes and tenant-only RLS predicates without a join. The application layer + an integrity check enforce that `partner_msa.tenant_id = partner_orgs.tenant_id` at write time.
- **RLS:** tenant-scoped (outermost), then tenant admins + tenant finance read/write; partner-org-admins read only their own row.
- **Wave 1 scope:** all columns ship; the columns drive `partner_fees.msa_snapshot` so they cannot be retrofitted.

## partner_fees

Per-hire fee accrual with frozen MSA terms at hire date. Already defined in `architecture.md` §7.8; reproduced here for completeness.

```sql
CREATE TABLE partner_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id),
  hire_id UUID NOT NULL REFERENCES employees(id),
  ownership_claim_id UUID NOT NULL REFERENCES candidate_ownership_claims(id),
  msa_snapshot JSONB NOT NULL,                     -- frozen copy of MSA terms at hire date
  total_fee_amount NUMERIC NOT NULL,
  initial_invoice_amount NUMERIC NOT NULL,         -- payable on Day 1
  probation_invoice_amount NUMERIC NOT NULL,       -- payable on probation pass
  status TEXT NOT NULL,                            -- pending | partial_invoiced | fully_invoiced | paid | disputed | clawback
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_partner_fees_tenant_org_status
  ON partner_fees (tenant_id, partner_org_id, status);
CREATE INDEX idx_partner_fees_tenant_hire
  ON partner_fees (tenant_id, hire_id);
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id` → `partner_orgs(id)`; `hire_id` → `employees(id)`; `ownership_claim_id` → `candidate_ownership_claims(id)`.
- **RLS:** tenant-scoped (outermost), then tenant admins + tenant finance read/write; partner-org-admins read only their own org's rows.
- **Wave 1 scope:** all columns ship; invoice generation UI is partial in Wave 1 (read-only commercials), full Wave 3.

## candidate_ownership_claims

The state machine. Already defined in `architecture.md` §7.4; reproduced here so the partner schema is in one place.

```sql
CREATE TABLE candidate_ownership_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  person_id UUID NOT NULL REFERENCES persons(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id),
  requisition_id UUID NULL REFERENCES requisitions(id),  -- NULL for speculative
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),  -- millisecond resolution
  expires_at TIMESTAMPTZ NOT NULL,                  -- claimed_at + window from partner_msa
  status TEXT NOT NULL,                             -- 'active' | 'expired' | 'voided' | 'transferred'
  voided_reason TEXT NULL,
  evidence JSONB NOT NULL                           -- submission record snapshot
);

-- The partial unique index is the database-level guarantee against simultaneous claims.
-- Per ADR-002 §5.1, the uniqueness scope must include tenant_id — without it, two tenants
-- with the same person_id (UUID collision is impossible, but referential semantics still
-- require this) and the same requisition_id (the requisition_id namespace is per-tenant)
-- would share a uniqueness constraint they shouldn't share. Tenant-scope the partial index.
CREATE UNIQUE INDEX one_active_claim_per_person_per_req
  ON candidate_ownership_claims (tenant_id, person_id, requisition_id)
  WHERE status = 'active';
CREATE INDEX idx_claims_tenant_partner_status
  ON candidate_ownership_claims (tenant_id, partner_org_id, status);
CREATE INDEX idx_claims_tenant_expires_active
  ON candidate_ownership_claims (tenant_id, expires_at)
  WHERE status = 'active';
```

- **FKs:** `tenant_id` → `tenants(id)`; `person_id` → `persons(id)`, `partner_org_id` → `partner_orgs(id)`, `requisition_id` → `requisitions(id)` (nullable).
- **RLS:** tenant-scoped (outermost), then tenant admins read all; partner users read only claims where `partner_org_id` matches their own. Other partners are told only "candidate already in pipeline" without identifying the owner (`requirements.md` §6.4 non-disclosure rule).
- **Wave 1 scope:** all columns + indexes ship — non-negotiable per `architecture.md` §7.12. The `(tenant_id, person_id, requisition_id)` partial-unique index is the load-bearing tenant + ownership guarantee.

## candidate_dedup_attempts

Audit of every submission attempt that did not become a candidate. Already defined in `architecture.md` §7.4.

```sql
CREATE TABLE candidate_dedup_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_by_partner_org_id UUID NULL REFERENCES partner_orgs(id),  -- NULL if direct application
  contact_email TEXT NULL,
  contact_phone TEXT NULL,
  resume_hash TEXT NULL,
  resolved_to_person_id UUID NULL REFERENCES persons(id),
  outcome TEXT NOT NULL,                            -- 'accepted' | 'rejected_duplicate' | 'rejected_invalid' | 'rejected_direct_application_exists'
  rejection_reason TEXT NULL
);

CREATE INDEX idx_dedup_tenant_partner_outcome
  ON candidate_dedup_attempts (tenant_id, attempted_by_partner_org_id, outcome);
CREATE INDEX idx_dedup_tenant_resolved_person
  ON candidate_dedup_attempts (tenant_id, resolved_to_person_id);
```

- **FKs:** `tenant_id` → `tenants(id)`; `attempted_by_partner_org_id` → `partner_orgs(id)` (nullable); `resolved_to_person_id` → `persons(id)` (nullable).
- **RLS:** tenant-scoped (outermost), then tenant admins read all; partner users read only their own attempts.
- **Wave 1 scope:** all columns ship.

## requisition_knockouts

Knockout questions per req. Cross-references `architecture.md` §5.1 (recruitment-core group, added in B3).

```sql
CREATE TABLE requisition_knockouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  req_id UUID NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  type TEXT NOT NULL,                                  -- 'boolean' | 'numeric_min' | 'numeric_max' | 'enum'
  threshold_value JSONB NOT NULL,                      -- e.g. {"min": 6} or {"allowed": ["IN","PH"]}
  source TEXT NOT NULL,                                -- 'parsed_cv' | 'candidate_asserted' | 'partner_asserted'
  order_index INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_knockouts_tenant_req
  ON requisition_knockouts (tenant_id, req_id, order_index);
```

- **FKs:** `tenant_id` → `tenants(id)`; `req_id` → `requisitions(id)`.
- **RLS:** tenant-scoped (outermost), then internal users read/write; partner users read knockouts for reqs they're assigned to (`partner-wireflows.md` §3.4 displays them).
- **Wave 1 scope:** all columns ship; UI for editing knockouts is internal-portal only.

## partner_candidate_messages

Logged partner-to-candidate messages. Referenced in `partner-wireflows.md` §3.10. Wave 1 stores the schema; the messaging UI itself ships in Wave 2 (per `requirements.md` §11). Storing the schema in Wave 1 lets us surface "messaging coming soon" without retrofitting later.

```sql
CREATE TABLE partner_candidate_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id),
  partner_user_id UUID NOT NULL REFERENCES partner_users(id),
  candidate_person_id UUID NOT NULL REFERENCES persons(id),
  application_id UUID NOT NULL REFERENCES applications(id),
  direction TEXT NOT NULL,                             -- 'outbound' | 'inbound'
  body_encrypted BYTEA NOT NULL,                       -- KMS-encrypted message text
  body_hash TEXT NOT NULL,                             -- for idempotency
  scanner_verdict TEXT NULL,                           -- 'clean' | 'soft_warn' | 'hard_block' (NULL for inbound)
  scanner_flags JSONB NULL,
  delivered_at TIMESTAMPTZ NULL,
  flagged_at TIMESTAMPTZ NULL,
  flagged_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pcmsgs_tenant_thread
  ON partner_candidate_messages (tenant_id, application_id, created_at);
CREATE INDEX idx_pcmsgs_tenant_partner_org
  ON partner_candidate_messages (tenant_id, partner_org_id, created_at DESC);
CREATE INDEX idx_pcmsgs_tenant_flagged
  ON partner_candidate_messages (tenant_id, partner_org_id, flagged_at)
  WHERE flagged_at IS NOT NULL;
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id`, `partner_user_id`, `candidate_person_id`, `application_id`.
- **RLS:** tenant-scoped (outermost), then partner users read only messages where `partner_org_id` matches their own AND (`partner_user_id` is themselves OR they're org-admin AND the message is flagged). Org-admins do not get content access on un-flagged messages — see `partner-wireflows.md` §3.10. Tenant admins read all in audit view; reads logged to `pii_access_log`.
- **Wave 1 scope:** schema only. Messaging UI + content scanner = Wave 2.

## intake_attempts

Audit of inbound email-intake attempts (parsed or rejected). Referenced in `partner-wireflows.md` §4.3.

```sql
CREATE TABLE intake_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  inbound_alias TEXT NOT NULL,                         -- e.g. 'cvs-REQ-2026-0847@kyndryl-hireops.com'
  resolved_req_id UUID NULL REFERENCES requisitions(id),
  sender_email TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  resolved_partner_org_id UUID NULL REFERENCES partner_orgs(id),
  attachment_count INT NOT NULL DEFAULT 0,
  parsed_cv_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  unparseable_count INT NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,                               -- 'accepted' | 'rejected_unknown_sender' | 'rejected_invalid_alias' | 'rejected_closed_req' | 'rejected_no_cv'
  raw_email_s3_key TEXT NULL                           -- pointer to KMS-encrypted full email payload
);

CREATE INDEX idx_intake_attempts_tenant_partner
  ON intake_attempts (tenant_id, resolved_partner_org_id, received_at DESC);
CREATE INDEX idx_intake_attempts_tenant_outcome
  ON intake_attempts (tenant_id, outcome, received_at DESC);
```

- **FKs:** `tenant_id` → `tenants(id)`; `resolved_req_id` → `requisitions(id)` (nullable); `resolved_partner_org_id` → `partner_orgs(id)` (nullable).
- **RLS:** tenant-scoped (outermost), then tenant admins read all. Partner users do not see this table (ad-hoc partners have no portal anyway).
- **Wave 1 scope:** all columns ship; surfaced in admin email-intake config view (`partner-wireflows.md` §5.2). Per ADR-002 §5.2, the per-req inbound alias namespace is per-tenant — `cvs-REQ-2026-0847@<tenant>.hireops.app` style routing or tenant-prefixed aliases handle multiple tenants having the same human-readable req-id.

## partner_activity_log

Per-org activity feed driving the dashboard "recent activity" panel (`partner-wireflows.md` §3.2).

```sql
CREATE TABLE partner_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id) ON DELETE CASCADE,
  actor_partner_user_id UUID NULL REFERENCES partner_users(id),
  actor_internal_user_id UUID NULL REFERENCES profiles(id),
  event_type TEXT NOT NULL,                            -- e.g. 'submission_created' | 'candidate_stage_changed' | 'req_opened_to_org' | 'invoice_generated'
  subject_application_id UUID NULL REFERENCES applications(id),
  subject_requisition_id UUID NULL REFERENCES requisitions(id),
  subject_candidate_person_id UUID NULL REFERENCES persons(id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activity_tenant_org_time
  ON partner_activity_log (tenant_id, partner_org_id, occurred_at DESC);
CREATE INDEX idx_activity_tenant_org_eventtype
  ON partner_activity_log (tenant_id, partner_org_id, event_type);
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id`, `actor_partner_user_id`, `actor_internal_user_id`, `subject_application_id`, `subject_requisition_id`, `subject_candidate_person_id`.
- **RLS:** tenant-scoped (outermost), then partner users read only rows for their own `partner_org_id`; tenant admins read all in their tenant.
- **Wave 1 scope:** all columns ship; events emitted from the application layer on relevant state transitions.

---

## Tables out of Wave 1 scope (deferred to commercial-extensions doc)

`partner-wireflows.md` §3.11 and §5.1 also reference the following names. None of them ship as distinct tables in Wave 1; their function is covered by `partner_fees` plus the wider notification framework, with full implementation in Wave 2 / Wave 3.

- **`placement_fees`** — alias for `partner_fees`. Use `partner_fees`. Not a separate table.
- **`partner_invoices`** — invoice generation + Kyndryl AP routing. Wave 3 per `requirements.md` §11. Schema deferred to a commercial-extensions doc once `requirements.md` §12 Q19 (Kyndryl AP integration) is answered.
- **`payments`** — payment status synced from Kyndryl AP. Wave 3, same blocker as above.
- **`partner_contracts`** — alias for `partner_msa` (the docs use both names interchangeably). Use `partner_msa`. Not a separate table.

`ad_hoc_partners` is also referenced separately — in this model it is **not** its own table. Ad-hoc partner orgs live in `partner_orgs` with `tier='ad_hoc'`, their commercial terms in `partner_msa` with the same `tier='ad_hoc'`, and their registered sender-domain list in a one-to-many child table:

## ad_hoc_partner_domains

```sql
CREATE TABLE ad_hoc_partner_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  partner_org_id UUID NOT NULL REFERENCES partner_orgs(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                                -- normalised lowercase
  default_consent_text TEXT NOT NULL,
  daily_quota INT NOT NULL DEFAULT 50,
  default_contact_email TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique per tenant, not globally — two tenants can each register acme-recruiting.com if both
-- separately empanel that vendor. Domain uniqueness within a tenant is the operating constraint.
CREATE UNIQUE INDEX idx_ad_hoc_domain_per_tenant
  ON ad_hoc_partner_domains (tenant_id, domain)
  WHERE active = TRUE;
CREATE INDEX idx_ad_hoc_tenant_org
  ON ad_hoc_partner_domains (tenant_id, partner_org_id, active);
```

- **FKs:** `tenant_id` → `tenants(id)`; `partner_org_id` → `partner_orgs(id)`.
- **RLS:** tenant-scoped (outermost), then tenant admins read/write only; ad-hoc partners have no portal.
- **Wave 1 scope:** all columns ship; consumed by the email-intake parser, which receives `tenant_id` from the inbound mailbox routing layer (per ADR-002 §5.2: tenant-prefixed aliases or per-tenant subdomain mailboxes) before sender-domain lookup.

---

## Reconciliation with `architecture.md` §7

What was already in `architecture.md` §7 and remains authoritative:

- `partner_orgs`, `partner_users` — referenced in §7.3 and §7.4. This doc adds full column definitions.
- `partner_msa` — defined in §7.8. This doc adds `tier`, `replacement_guarantee_days`, `replacement_mode` columns (per B5) and updates the holdback default comment (per B6).
- `partner_fees` — defined in §7.8. Reproduced here unchanged.
- `candidate_ownership_claims` — defined in §7.4. Reproduced here with `tenant_id` added per ADR-002. The unique partial index is now `(tenant_id, person_id, requisition_id) WHERE status = 'active'` — tenant-scoping the partial-unique constraint is non-negotiable: without it, two tenants with the same `requisition_id` value (the namespace is per-tenant) would share the uniqueness constraint they shouldn't share.
- `candidate_dedup_attempts` — defined in §7.4. Reproduced here.

What this doc adds (these tables are referenced in `partner-wireflows.md` but were not previously specified):

- `partner_invitations` — first-touch invite-token storage.
- `partner_assignments` — which empanelled orgs can source for which reqs.
- `requisition_knockouts` — also added to `architecture.md` §5.1 recruitment-core group per B3.
- `partner_candidate_messages` — schema only in Wave 1; messaging UI in Wave 2.
- `intake_attempts` — audit of inbound email-intake.
- `partner_activity_log` — dashboard activity feed.
- `ad_hoc_partner_domains` — sender-domain registry; replaces the implied `ad_hoc_partners` standalone table.

Names that are aliases or deferred:

- `placement_fees` → use `partner_fees`.
- `partner_contracts` → use `partner_msa`.
- `partner_invoices`, `payments` → Wave 3, separate doc.
- `submissions` → use `applications` with `source_partner_id` (per `architecture.md` §5.1 note added in B2).
