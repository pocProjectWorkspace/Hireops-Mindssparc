# HireOps — Open Questions and Contradictions

**Status:** Internal modelling pass against the four design docs as of 2026-05-08. **Resolution pass applied 2026-05-08** — every contradiction and gap below carries an inline `**RESOLVED:**` note describing the fix, with the original analysis preserved as historical record.
**Method:** Read each doc end-to-end, then triangulated across docs for inconsistencies. Where two passages can be reconciled with a charitable reading, I noted that — but listed the conflict so the resolution is explicit.

---

## a) Contradictions found in the design docs

Eight conflicts found. Listed in rough order of how much they affect Wave 1 implementation.

### 1. Ad-hoc partner ownership: do they carry it or not?

Three passages point in three directions.

- `requirements.md` §6.4, edge case row: *"Empanelled partner A submits → ownership lapses → ad-hoc agency emails same CV → HireOps re-creates dedup-matched record | **Ad-hoc submissions never carry ownership (no MSA backing)**. Candidate becomes available for direct sourcing."*
- `requirements.md` §6.5, ad-hoc intake: *"Same dedup + ownership rules apply, but ad-hoc partners get **a flat reduced fee** (or no fee, depending on MSA — most ad-hoc engagements are pay-per-hire-only with lower rates)."*
- `partner-wireflows.md` §4.1 (mermaid sequence for email-intake): *"P->>DB: Create candidate, application, **ownership_claim** (partner = lookup result), consent_record (default attestation from email body)"*

§6.4 says ad-hoc never carry ownership. §6.5 says ownership rules apply but with a reduced fee. §4.1 explicitly creates an `ownership_claim` row for ad-hoc submissions. EMI-05 in the backlog cannot be specified until this is resolved.

**RESOLVED:** Ad-hoc submissions DO carry ownership. The §6.4 edge-case row was rewritten to: "Ad-hoc submissions DO create ownership claims, but with: (a) a 60-day window (shorter than empanelled 90-day, recognising lower MSA backing), (b) fee per `ad_hoc_partners.default_fee_terms` with no holdback, (c) ad-hoc claims lose to empanelled claims in disputes when both are within window." §6.5 was updated to cite the 60-day window explicitly. EMI-05 in the backlog now describes this behaviour and is no longer blocked on the contradiction (only on Q16 for the actual fee values).

### 2. Email-intake mailbox pattern: per-partner or per-req?

- `requirements.md` §6.5: *"Kyndryl operates a per-partner email alias: `partner-acme-cvs@kyndryl-hireops.com`. Each empanelled-but-not-portal-using or ad-hoc partner gets their own alias for attribution."*
- `architecture.md` §7.9: *"`partner-acme-cvs@kyndryl-hireops.com` → routed to S3 bucket via SES"* — agrees with `requirements.md` (per-partner alias is the attribution mechanism).
- `partner-wireflows.md` §4.2: *"**Inbound mailbox pattern:** `cvs-{req-id}@kyndryl-hireops.com`"*, with examples `cvs-REQ-2026-0847@kyndryl-hireops.com` and `cvs-talent-pool@kyndryl-hireops.com`.

These are different attribution mechanisms. Per-partner aliases attribute by sender mailbox; per-req aliases attribute by recipient mailbox and require sender-domain lookup as the partner attribution. `requirements.md` §12 Q20 even names this open: *"Will Kyndryl provision per-partner email addresses (`partner-acme-cvs@kyndryl-hireops.com`) or do we need a different attribution mechanism?"* — implying §6.5 was a working assumption rather than a locked decision.

A reading that reconciles both: the mailbox pattern is per-req (`partner-wireflows.md`) and partner attribution comes from sender-domain lookup (`partner-wireflows.md` §4 mermaid does this). That makes §6.5's per-partner alias either obsolete or a parallel mechanism. Worth deciding which one is canonical before EMI-01 lands.

**RESOLVED:** Per-req aliases (`cvs-{req-id}@kyndryl-hireops.com`) plus a single `cvs-talent-pool@…` alias are the routing mechanism; partner attribution comes from sender-domain lookup against `ad_hoc_partner_domains`. `requirements.md` §6.5, `architecture.md` §7.9, and `requirements.md` §12 Q20 all updated accordingly.

### 3. Persona count: the doc says 12, enumerates 13

- `requirements.md` §3.3 closing line: *"**Final persona count: 12.** This is significantly more than Lovable's 7 but it is honest about the actual operating reality of a GCC at this scale."*
- Lovable's 7 personas (`requirements.md` §3 opening): `requirement_owner`, `hr_head`, `recruiter`, `panel`, `hr_team`, `candidate`, `admin`.
- §3.3 lists 6 net-new personas: People Ops, IT/Workplace Services, HR Partner, BGV Vendor, Hiring Approver Chain, Employee.
- 7 + 6 = 13, not 12. Even if HR Head's "split" into TA Lead + HR Director (`requirements.md` §3.2) is collapsed back to 1 persona for POC, the count still totals 13.

Charitable reading: Employee may be intended as a continuation of the Candidate persona (`requirements.md` §3.3 says *"Once onboarded, the candidate becomes an employee with ongoing rights ... Carries forward the candidate portal"*) rather than a separate persona. With Employee folded in, the count is 12. But §3.3 still lists Employee as a row in the new-personas table, so the count is at minimum ambiguous.

**RESOLVED:** Count corrected to 13 in `requirements.md` §3.3, with the supporting math made explicit (Lovable's 7 + 6 net-new = 13). Employee remains a distinct persona in the enumeration.

### 4. Workday Pre-Hire timing: on offer-accept or on Day 1?

- `requirements.md` §7.2 (and §5.6, §9.1): *"Pre-Hire creation in Workday | On offer-accept, create Workday Pre-Hire (SOAP `Put_Applicant`...)"*. Hire_Employee is fired separately *"on Day 1"* of the new hire.
- `workday-adr.md` §5.1 table: agrees — Pre-Hire trigger is "Offer accepted", Hire trigger is "Day 1 of new hire".
- `workday-adr.md` §5.2 mermaid sequence: shows Put_Applicant **and** Hire_Employee triggered together, in a single sequence opened by *"Recruiter clicks 'Mark as Hired' on candidate"*. The diagram makes them happen in one worker run.

Either the §5.2 sequence diagram is an illustrative simplification, or the actual implementation collapses both calls into one event. They have different semantics — Pre-Hire on offer-accept gives the candidate a Workday Applicant ID weeks before Day 1 (useful for some downstream Workday flows), while collapsing them postpones Workday entry until the hire. WD-10 vs WD-11 sequencing depends on which is canonical.

Related: `workday-adr.md` §5.2 names "**Recruiter** clicks 'Mark as Hired' on candidate" as the trigger. By the canonical lifecycle in `requirements.md` §4, recruitment closes at Offer Accepted; the hire itself happens during the Onboarding band. The actor who initiates the Workday Hire is more naturally People Ops on Day 1, or an automated trigger. This is at most a minor inaccuracy in the diagram but it does undermine reading §5.2 as the source of truth for the trigger.

**RESOLVED:** Pre-Hire and Hire are explicitly two distinct events at two distinct moments, both auto-triggered. Pre-Hire fires automatically on the e-sign `offer_accepted` webhook; Hire fires automatically on a Day-1 cron-style scheduler at 00:00 IST. `workday-adr.md` §5.2 was rewritten as two separate sequence diagrams (one per event) and §5.1 sync table now flags both rows as auto-triggered. `requirements.md` §7.2 also tightened to make the auto-trigger explicit.

### 5. Speculative-submission ownership window: 90 days or 180?

- `requirements.md` §6.4 core rule: *"First valid submission wins, with a 90-day exclusivity window per candidate, scoped to the req they were submitted against."*
- `requirements.md` §6.4 edge case ("Candidate submitted to a req that gets cancelled"): *"Ownership transfers to the speculative talent pool for **the remainder of the 90-day window**."* — implying 90 days applies to speculative too.
- `partner-wireflows.md` §3.9 "Permission notes": *"Different ownership rules: speculative submissions have a **180-day window** (vs 90 for req-bound)."*
- `partner-wireflows.md` §8 (open questions list): *"Speculative submission ownership window — proposed 180 days. Confirm with Kyndryl legal."*

The §8 entry treats 180 as a proposal still requiring legal confirmation; §3.9 treats it as a stated rule. `requirements.md` §6.4 either contradicts or hasn't been updated to reflect the 180-day proposal.

Wave 1 doesn't ship speculative submissions (`requirements.md` §11 puts them in Wave 2), so this can be deferred — but the schema for `candidate_ownership_claims.expires_at` calculation must accommodate both windows once speculative ships.

**RESOLVED:** Three windows codified in `requirements.md` §6.4 — 90 days req-bound, 180 days speculative, 60 days ad-hoc. Edge-case row for cancelled reqs updated so ownership transfers to talent pool with the window resetting to 180 days from original submission date (or remainder of 90-day clock, whichever is greater). `partner-wireflows.md` §3.9 language tightened to match.

### 6. "Scoped to the req" vs cross-req fee attribution

- `requirements.md` §6.4 core rule: *"First valid submission wins, with a 90-day exclusivity window per candidate, **scoped to the req they were submitted against**."*
- `requirements.md` §6.4 detail bullet: *"If Candidate X is hired into a different req at Kyndryl during the 90-day window, default rule: Partner A's fee applies, **unless** their MSA explicitly limits exclusivity to the originally-submitted req."*

The core rule says scoped-to-req; the detail bullet says default-cross-req with MSA-controlled limitation back to the req. These can be reconciled (the default is cross-req, the MSA can narrow it back), but the core rule's phrasing "scoped to the req" is misleading given the default behaviour.

**RESOLVED:** Core rule rewritten in `requirements.md` §6.4 to say: "By default, ownership applies to the candidate at Kyndryl during the active window — meaning if the candidate is hired into a different req at Kyndryl while the window is active, the original partner is still entitled to the fee. MSAs MAY narrow this default to attribute only to the originally-submitted req; this is an MSA-driven configuration, not the platform default." The detail bullet now matches.

### 7. Holdback percentage default: 25% or 50%?

- `architecture.md` §7.8 (table comment): *"`probation_holdback_pct` NUMERIC NOT NULL, -- **e.g. 50.00 = 50%** withheld until probation"*.
- `partner-wireflows.md` §5.1 (admin invite form): *"Holdback percentage (default 25%, overridable)"*.

This may be benign — `architecture.md` is showing an illustrative example value in a column comment, while `partner-wireflows.md` is naming the admin-form default. But the difference (25% vs 50%) is large enough that whichever lands as the actual seeded default will affect partner conversations. Worth aligning.

**RESOLVED:** `architecture.md` §7.8 column comment updated to "e.g. 25.00 = 25% (Wave 1 default)" matching `partner-wireflows.md` §5.1. Also reflected in `partner_msa.probation_holdback_pct DEFAULT 25.00` in `/docs/partner-data-model.md`.

### 8. Workday "outbound webhooks": does it really not have them?

- `workday-adr.md` §1, point 1: *"Workday does not natively support outbound webhooks for HR data changes. This is a fundamental constraint — every 'real-time' pattern from Workday to HireOps is actually polling."*
- `requirements.md` §9.1, table row "Positions": *"Near-real-time (**webhook or 15-min poll**)"*.
- `architecture.md` §6.1, table row "Positions": *"15-min poll, **eventually webhook**"*.

`workday-adr.md` makes this a hard constraint with no path to webhooks. `requirements.md` and `architecture.md` both reference webhooks as either a current or future option. Possibly reconcilable if "webhook" in the latter two means a third-party "virtual webhook" (vendor like Knit/Merge polls on our behalf — `workday-adr.md` §1 mentions these). But the language reads as if the two earlier docs hadn't been told about §1 yet. Wave 1 only requires polling per `workday-adr.md` so this is non-blocking, but it's worth pruning the "webhook" language from the older docs to avoid future confusion.

**RESOLVED:** Webhook language removed. `requirements.md` §9.1 Positions row now reads "15-min poll (Workday does not natively support outbound webhooks; see `workday-adr.md` §1)." `architecture.md` §6.1 Positions and Job-profiles rows updated similarly, with an explicit note on "virtual webhook" vendors being out-of-scope for POC.

---

## b) Gaps that block Wave 1

Things the docs assume but don't fully specify.

### 1. Many partner-related tables are referenced in `partner-wireflows.md` but not defined in `architecture.md` §5.1 or §7

`partner-wireflows.md` references all of: `partner_invitations`, `partner_assignments`, `submissions`, `partner_submission_draft`, `requisition_knockouts`, `partner_candidate_messages`, `placement_fees`, `partner_invoices`, `payments`, `partner_contracts` (likely a synonym for `partner_msa`), `ad_hoc_partners`, `intake_attempts`, `partner_activity_log`. None of these appear in `architecture.md` §5.1 (the data model section) or §7.4 / §7.8 (the named partner tables).

**Where it should live:** in a partner schema appendix to `architecture.md` (or in a future ADR specifically for the partner data model). The minimum to unblock Wave 1: explicit definitions for `partner_invitations`, `partner_assignments`, `requisition_knockouts`, `ad_hoc_partners`, `submissions` (or rename — see next gap), and a clear statement on whether `partner_contracts` is the same row as `partner_msa`.

**Proposed direction:** treat `architecture.md` §7.4 and §7.8 as authoritative for the tables they name, treat anything else referenced only in `partner-wireflows.md` as a placeholder requiring schema specification before the implementing tasks (DB-10, DB-11, DB-25 in the backlog). Open `docs/partner-data-model.md` as the consolidation point.

**RESOLVED:** `/docs/partner-data-model.md` created with full column definitions for `partner_orgs`, `partner_users`, `partner_invitations`, `partner_assignments`, `partner_msa` (unified across empanelled and ad-hoc), `partner_fees`, `candidate_ownership_claims`, `candidate_dedup_attempts`, `requisition_knockouts`, `partner_candidate_messages`, `intake_attempts`, `partner_activity_log`, and `ad_hoc_partner_domains`. PRT-11 added to the backlog to land the additions in `packages/db`.

### 2. `submissions` vs `applications` — same table or distinct?

`requirements.md` §6.4 and `partner-wireflows.md` use the verb "submission" for partner candidate submissions, and `partner-wireflows.md` §3.5 and §3.7 reference a `submissions` table. `architecture.md` §5.1 keeps `applications` (Lovable's recruitment table). It is unclear whether a partner submission is *the same row* as an `applications` row tagged with `source_partner_id`, or whether `submissions` is a separate parent table that produces an `applications` row downstream.

**Where it should live:** explicit statement in `architecture.md` §7 (probably §7.5 "Submission flow"). §7.5 currently says *"Insert candidate record + application record + ownership claim in single transaction"* — implying one `applications` row per submission. So most likely `submissions` is informal language for the same row. But that needs to be written down because `partner-wireflows.md` §3.7 reads "candidates from `submissions` WHERE `partner_org_id = ...`" which sounds like a distinct table.

**Proposed direction:** unify. Add `applications.source_partner_id`, `applications.submitted_by_partner_user_id`, `applications.partner_submission_metadata`. Drop the separate `submissions` table.

**RESOLVED:** `architecture.md` §5.1 now carries the unification note: partner submissions use `applications` with new columns `source_partner_id`, `submitted_by_partner_user_id`, `partner_submission_metadata`. §7.5 updated to reflect the same. `submissions` is documented as informal language only; `/docs/partner-data-model.md` "Reconciliation" section confirms.

### 3. `requisition_knockouts` schema is undefined

Knockout questions are referenced in `requirements.md` §5.4, displayed in `partner-wireflows.md` §3.4, and gated on in §3.5 (single submit) and §3.6 (bulk submit), and `partner-wireflows.md` §3.4 references a `requisition_knockouts` table. The data shape is undefined — questions can be Y/N (the examples shown) or numeric thresholds (e.g., "Years of Java experience ≥ 6"). Whether knockouts are computed against parsed CV data, candidate-asserted form fields, or a mix, isn't specified.

**Where it should live:** `architecture.md` §5.1 alongside the recruitment-core tables, or an extension to the `jd_skills` schema.

**Proposed direction:** define `requisition_knockouts(req_id, question_text, type ENUM('boolean','numeric_min','numeric_max','enum'), threshold_value, source ENUM('parsed_cv','candidate_asserted','partner_asserted'))`. Document the evaluator. Schema is small; specifying it should not delay Wave 1.

**RESOLVED:** Schema added to `architecture.md` §5.1 (recruitment-core group) and `/docs/partner-data-model.md`. Backlog row DB-25 already exists for the migration.

### 4. Recruiter side of receiving an application

The candidate apply flow is documented from the candidate's perspective (`requirements.md` §5.3) and from the partner's perspective (`partner-wireflows.md` §3.5, §4). The recruiter side — *what does a recruiter see when an application lands* — is implied (e.g., "notify Kyndryl recruiter assigned to this req" `partner-wireflows.md` §3.5 mermaid) but not specified in any of the four docs. The Lovable page audit (`requirements.md` §10.1) lists `RecruiterCandidates` and `RecruiterShortlist` as keep-with-modify, but the design behaviour for "new application landed in my queue" isn't pinned down.

**Where it should live:** an extension to `requirements.md` §5.3 (sourcing & intake) or a new `requirements.md` §5.3a covering recruiter-side intake/triage.

**Proposed direction:** specify the new-application behaviour: notification channel (in-app + email), default assignment rule (recruiter assigned to req), bulk acceptance/triage support boundaries (Wave 2 for bulk), and the SLA (e.g., recruiter responds within 24h or it's flagged). INT-04 in the backlog needs this to be specified.

**RESOLVED:** New `requirements.md` §5.3a "Recruiter intake & triage" added covering notification channels (in-app + email digest), default assignment rule (recruiter on req at posting time, reassignment logged), 24-working-hour triage SLA with breach surfaced on dashboards, and bulk triage explicitly deferred to Wave 2.

### 5. Hiring Approver Chain — auth path and surface not pinned down

The Hiring Approver Chain persona (`requirements.md` §3.3) is described as *"Lightweight inbox view: approve / reject with comment. Often mobile."* No specification of:

- Whether they live inside the internal portal (Kyndryl SSO) or have a thin email + magic-link surface.
- Whether some approvals originate in Workday and reflect into HireOps (`requirements.md` §5.1 implies yes for some) — and if so, what the integration surface is.
- Whether the multi-level approval workflow is the same workflow that drives requisition approvals (`requirements.md` §5.1, §5.6) or distinct.

**Where it should live:** `architecture.md` §9.1 (auth row for Approver Chain) and `architecture.md` §6 (Workday integration, approvals direction).

**Proposed direction:** for Wave 1, treat all approver actions as internal-portal pages reachable from email deep-links, with full SSO. Approvals that originate in Workday are read-back via reconciliation (no inbound webhook). Revisit if Kyndryl asks for a thin mobile-only experience.

**RESOLVED:** New row added to `architecture.md` §9.1 auth table for "Hiring Approver Chain": SSO via Kyndryl IdP, MFA mandatory, lightweight inbox view inside `apps/internal-portal` reachable from email deep-links; Workday-originated approvals read back via reconciliation, not pushed.

### 6. BGV Vendor auth pattern

`requirements.md` §3.3 calls BGV Vendor *"API-only persona — no UI. Webhook-fed status updates."* `architecture.md` §9.1 specifies *"API key + IP allowlist"* as the auth mechanism, and §8.1 names possible vendors. But:

- The webhook signature pattern (HMAC, signed JWT, etc.) is not specified.
- IP allowlist scope (per-environment? per-vendor?) is not specified.
- Whether HireOps initiates checks via the vendor's REST or via per-vendor SDKs is not specified.

**Where it should live:** an extension to `architecture.md` §8.1 (BGV vendor) once the vendor is selected — `requirements.md` §12 Q5 is explicit that the vendor itself is a Kyndryl decision.

**Proposed direction:** specify webhook auth (HMAC of body with shared secret) and IP allowlist scope (per-environment). Defer vendor-specific bindings until Q5 is answered.

**RESOLVED:** `architecture.md` §8.1 extended with a "Webhook authentication and isolation" paragraph: HMAC-SHA256 of request body using a per-vendor per-environment shared secret in Vault, IP allowlist scoped per environment at the Cloudflare WAF tier, vendor-specific bindings live behind `packages/bgv-client` once Q5 is answered.

### 7. Geography-specific document categories

`requirements.md` §7.1 lists India-specific (Form 11, Form F, PAN, Aadhaar, tax declaration) and Philippines-specific (BIR 2316, SSS, PhilHealth, Pag-IBIG) document categories as part of pre-board collection, but `architecture.md` §5.1 has only `onboarding_documents` — a single table — without a typed taxonomy for document categories or their geography mapping.

**Where it should live:** either a `document_types` lookup table referenced from `onboarding_documents.document_type_id`, or an enum in the schema with geography filtering.

**Proposed direction:** define `document_types(id, code, name, geography_code, required_for_lifecycle_stage, retention_years)` — small lookup table, drives both UI rendering and retention. ONB-03 in the backlog cannot be implemented well without this.

**RESOLVED:** Schema added to `architecture.md` §5.1 onboarding group with `document_types(id, code TEXT UNIQUE, name TEXT, geography_code CHAR(2), required_for_lifecycle_stage TEXT, retention_years INT)` plus `onboarding_documents.document_type_id` FK. `requirements.md` §7.1 carries a paragraph documenting the taxonomy.

### 8. Replacement-guarantee mechanics

`partner-wireflows.md` §5.1 (admin invite) lists *"Replacement guarantee (default 90-day, overridable)"* and §8 Q4 marks it open: *"when a hire leaves in 90 days, does the partner get a free replacement attempt or just clawback? Both? Per-MSA?"*. `requirements.md` §6.8 mentions clawback but not the free-replacement mechanic.

**Where it should live:** `requirements.md` §6.8 (commercial workflow) and `architecture.md` §7.8 (`partner_msa` field set).

**Proposed direction:** add `partner_msa.replacement_guarantee_days` and `partner_msa.replacement_mode ENUM('clawback_only','free_replacement','hybrid')`. The mechanic is per-MSA so it has to be stored and snapshotted into `partner_fees.msa_snapshot` like the rest of the commercial terms. Wave 1 ships clawback-only behaviour and leaves replacement_mode='clawback_only' as the seed, with the field present so Wave 2 can extend.

**RESOLVED:** `partner_msa` extended in `architecture.md` §7.8 (and reproduced in `/docs/partner-data-model.md`) with `replacement_guarantee_days INT NOT NULL DEFAULT 90` and `replacement_mode TEXT NOT NULL DEFAULT 'clawback_only'`. Wave 1 ships clawback-only seed; `free_replacement` and `hybrid` available for Wave 2 per MSA.

### 9. Fee schedule for ad-hoc partners

`requirements.md` §6.5 describes ad-hoc fees as *"a flat reduced fee (or no fee, depending on MSA — most ad-hoc engagements are pay-per-hire-only with lower rates)"*. `partner-wireflows.md` §5.1 says ad-hoc registration captures *"Default fee terms (per-hire flat fee or percentage)"*. No detail on the schedule itself or how it interacts with the empanelled holdback/probation logic.

**Where it should live:** `architecture.md` §7.8 — extend `partner_msa` (or introduce an analogous `ad_hoc_partner_fees` table) to cover ad-hoc terms.

**Proposed direction:** ad-hoc partners share the `partner_msa` table with `tier='ad_hoc'`, fee_structure='flat_per_hire' as default, no probation_holdback (because no contractual basis for holdback without MSA). The fee structure is one of the things `requirements.md` §12 Q16 (MSA template) asks Kyndryl to provide.

**RESOLVED:** `partner_msa` carries a `tier TEXT NOT NULL` column ('empanelled' | 'ad_hoc') per `architecture.md` §7.8 and `/docs/partner-data-model.md`. Ad-hoc seed defaults: `fee_structure='flat_per_hire'`, `probation_holdback_pct=0`, `replacement_mode='clawback_only'`, `exclusivity_window_days=60`, `signed_msa_url=NULL`. Actual fee values still depend on Q16 MSA template.

### 10. Partner-org-admin scope

`partner-wireflows.md` §3.10 (messaging) says messages are scoped per-recruiter, but `partner-wireflows.md` §3.11 (commercials) and §3.12 (team management) are partner-org-admin only. Whether a partner-org-admin can read all their org's recruiters' messages, or only see commercials, is unspecified. `partner-wireflows.md` §8 Q1 is open: *"should partner-org-admin have ability to override their own recruiters' submissions? (current design: no)"*.

**Where it should live:** `partner-wireflows.md` §3.10 should specify whether partner-org-admins can audit their own recruiters' messages; today it's implicit.

**Proposed direction:** partner-org-admin sees all of their org's submissions, candidates, pipeline, and aggregated commercials, but **cannot** read message content unless flagged. This mirrors how Kyndryl admins behave (audit-only). Partner-org-admin override of submissions stays "no" per §8 Q1's stated direction.

**RESOLVED:** `partner-wireflows.md` §3.10 extended with explicit "Partner-org-admins ... cannot read message content unless a message has been flagged by content monitoring." `partner-wireflows.md` §8 Q1 marked RESOLVED with the same direction. RLS policy on `partner_candidate_messages` in `/docs/partner-data-model.md` codifies this.

### 11. Workday "approver chain" inside Workday — how many steps?

`workday-adr.md` §4 ("Assumptions this decision makes") says *"Kyndryl's Hire BP and Terminate BP have at most 1-2 approval steps (otherwise our completion-polling logic gets more elaborate)."* This is an assumption, not a verified fact. If Kyndryl's actual Hire BP has 5 steps, the 24h polling SLA in `workday-adr.md` §5.2 is too short and WD-11 in the backlog needs revisiting.

**Where it should live:** validation in week 1 of Wave 1, recorded in `runbooks/workday.md` (`workday-adr.md` §6 references it).

**Proposed direction:** week-1 audit of Kyndryl's Hire BP and Terminate BP step counts. If >2 steps, escalate to Kyndryl HRIS Lead to either trim BP for API-driven hires or extend HireOps polling SLA.

### 12. Decisions named "open" in source docs but not labelled blocking

The four docs each have an "open questions" or "open decisions" section, but they don't always indicate blocking-ness for Wave 1. (See section c below for a triaged version.) Wave 1 cannot start cleanly until at minimum: GCC location, Workday tenant access, SSO provider, BGV vendor, partner panel composition, MSA template, hosting region, Postgres host, API runtime host, e-signature provider, calendar (single or both), interview platform are answered.

---

## c) Decisions still open per `requirements.md` §12 and `architecture.md` §17

After the resolution pass, the count of genuinely Wave-1-blocking Kyndryl decisions has dropped from 21 to **8**. Architecture decisions have all been resolved with defensible defaults (subject to Kyndryl override). The remaining 8 are decisions only Kyndryl can make.

### Wave 1 blocking — Kyndryl conversation (8 questions, with our recommended defaults)

- **`requirements.md` §12 Q1 — GCC location.** Recommended default: India (Bangalore) for POC. Drives DB region, document types (PAN/Aadhaar/Form 11/Form F), holiday calendars, language defaults, payroll forms. Confirm or override.
- **`requirements.md` §12 Q2 — Workday tenant access.** No default possible — Kyndryl must provision: sandbox tenant + ISU + ISG + OAuth client by week 1. True blocker for WD-01 onwards (the entire integration critical path).
- **`requirements.md` §12 Q4 — SSO provider.** Recommended default: Okta if Kyndryl-IdP is Okta-backed, otherwise Azure AD. Pick one. Affects FND-06, INT-02, ONB-06 (SCIM target).
- **`requirements.md` §12 Q5 — BGV vendor.** Recommended default: AuthBridge for India POC (fast, India-strong); HireRight if Kyndryl already has a contract. Pick one. Affects ONB-04, ONB-05. (Same as `architecture.md` §17 Q9.)
- **`requirements.md` §12 Q8 — Approval matrix.** No safe default — Kyndryl's documented approval matrix per grade/cost is required to seed `approval_chains`. Affects DB-24, INT-11, INT-13.
- **`requirements.md` §12 Q15 — Partner panel composition for Wave 1.** Recommended default: 3-5 high-volume empanelled partners committed by week 2. Without named partners, the partner thin slice has no realism check.
- **`requirements.md` §12 Q16 — Partner MSA template.** No safe default — Kyndryl's standard MSA covering fee structures, exclusivity terms, payment terms, dispute clauses, replacement-guarantee mechanic seeds `partner_msa` rows. Without it, the commercial schema is guessing.
- **`requirements.md` §12 Q18 — Partner panel governance.** Recommended default: TA Lead owns partner relationships (with VMO copy on commercials). Confirm or override. Drives admin permissions on INT-21 and team-mgmt scope on PRT-10.

### Resolved with defaults (subject to Kyndryl override)

These were Wave-1-blocking before the resolution pass; they now have defensible defaults applied in the source docs. Listed for Kyndryl's reference; any override moves them back to "blocking" until reflected in the docs.

- **`requirements.md` §12 Q3 — Kyndryl careers site.** Default: HireOps-hosted careers site for POC. If `careers.kyndryl.com` must front, CRS-02 doubles in scope (proxy/redirect work). Confirm if HireOps-hosted is acceptable.
- **`requirements.md` §12 Q7 — IT provisioning systems.** Default: Okta SCIM target if Kyndryl IdP is Okta; Azure AD SCIM if Azure. Manual stub for any apps without SCIM. Same answer as Q4.
- **`requirements.md` §12 Q11 — SOC 2 / ISO 27001 timeline.** Default: out of POC scope; production-roadmap blocker.
- **`requirements.md` §12 Q12 — Branding.** Default: Kyndryl colours + "powered by HireOps" footer; full brand polish in Wave 2.
- **`requirements.md` §12 Q14 — Languages.** RESOLVED in §12: English only for POC.
- **`requirements.md` §12 Q20 — Ad-hoc partner email aliases.** RESOLVED in §12: per-req aliases + sender-domain attribution.
- **`architecture.md` §17 Q1 — Hosting region.** Default: ap-south-1 (Mumbai), single-region for POC.
- **`architecture.md` §17 Q2 — Postgres host.** Default: Supabase managed for POC; revisit RDS/CloudSQL for production.
- **`architecture.md` §17 Q3 — API runtime host.** Default: Fly.io for POC.
- **`architecture.md` §17 Q4 — Object storage.** Default: S3 + KMS.
- **`architecture.md` §17 Q5 — LLM primary.** Default: Anthropic Claude direct as primary; Bedrock retained as fallback. Override if data-residency policy mandates Bedrock.
- **`architecture.md` §17 Q6 — Career site framework.** Default: Next.js with SSR (already committed in §4.1).
- **`architecture.md` §17 Q7 — Mobile strategy.** Default: PWA-quality responsive web for POC; native deferred to post-POC.
- **`architecture.md` §17 Q10 — E-signature provider.** Default: DocuSign; Adobe Sign as alternative if Kyndryl already has a contract.
- **`architecture.md` §17 Q11 — Calendar.** Default: both Google + Outlook from POC.
- **`architecture.md` §17 Q12 — Interview platform.** Default: Zoom; pivot to Teams is straightforward.
- **`partner-wireflows.md` §8 Q1 — Partner-org-admin override of recruiter submissions.** Default: no. Org-admin sees aggregated metrics + commercials but cannot edit recruiter submissions or read message content unless flagged.
- **`partner-wireflows.md` §8 Q2 — Speculative submission ownership window.** Default: 180 days, codified in `requirements.md` §6.4.
- **`partner-wireflows.md` §8 Q4 — Replacement guarantee mechanics.** Default: clawback-only as Wave 1 seed; schema accommodates `free_replacement` and `hybrid` for Wave 2 per MSA.
- **`partner-wireflows.md` §8 Q6 — Mobile partner portal.** Default: mobile-responsive web for POC; native deferred.
- **`partner-wireflows.md` §8 Q7 — Multi-language consent text.** Default: English Wave 1; Hindi/Tagalog Wave 2/Phase 2.
- **`partner-wireflows.md` §8 Q8 — Partner-side webhooks.** Default: Phase 2 capability; not in POC.

### Needed by Wave 2 (not blocking Wave 1)

- **`requirements.md` §12 Q6 — Job-board contracts (LinkedIn Recruiter seats, Naukri RMS).** Job-board posting is in Wave 2 per §11, so Wave 1 doesn't need this. Decide before Wave 2.
- **`requirements.md` §12 Q9 — Compensation bands & grade structure.** Wave 1 uses simple comp recommendations; full comp engine is Wave 2.
- **`architecture.md` §17 Q8 — Job-board partnerships, which boards mandatory.** Same as Q6 above.
- **`partner-wireflows.md` §8 Q3 — Bulk submit quota.** Bulk submission is Wave 2.
- **`partner-wireflows.md` §8 Q5 — Talent-pool re-prompt at 24-month consent expiry.** Talent pool is Wave 2.

### Non-blocking (POC tolerance)

- **`requirements.md` §12 Q10 — Production data residency requirement (ap-south-1 vs us-east-1 vs EU).** POC runs in ap-south-1 single-region (per Q1 default); production residency is a question for the production roadmap.
- **`requirements.md` §12 Q13 — Volume ramp (300/month from go-live or stepped).** Affects production rollout, not Wave 1 build.
- **`requirements.md` §12 Q17 — Existing partner data migration.** `architecture.md` risk row "partner adoption" recommends starting with 3-5 friendly empanelled vendors in Wave 1 and growing the panel in Wave 2; migration is therefore a separate workstream when known partners come on.
- **`requirements.md` §12 Q19 — Invoicing & finance integration (SAP / Oracle / Coupa).** Wave 3 per `requirements.md` §11 ("Partner invoice integration with Kyndryl finance / AP" listed as Wave 3).
