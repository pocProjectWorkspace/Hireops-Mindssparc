# HireOps — Post-Demo Onboarding Scope

**Status:** Internal canonical onboarding plan. What gets built and
configured in the weeks after Kyndryl signs the POC contract.

**Assumed contract signing:** ~2 weeks after demo (early September 2026).
**Onboarding window:** ~8 weeks from contract sign to Kyndryl go-live with
real candidates (~end of October 2026).

**Why tighter than the v1 draft:** the wedge proof-of-pattern + working
core are shipped by the demo date. Onboarding is no longer "build the
platform" — it's "configure HireOps for Kyndryl + ship the Tier 1
production-readiness items that don't block the demo but do block real
candidates."

**Last updated:** 2026-05-28

---

## 1. What onboarding delivers

By end of onboarding, Kyndryl can point real candidates at HireOps for
their actual hiring pipeline. That means:

- **Kyndryl-configured.** Their tenant, their users, their approval
  matrix, their integrations, their templates, their branding.
- **Real integrations.** Real Workday connector replacing the simulator.
  Real e-signature replacing click-is-acceptance. SSO via Kyndryl's
  IdP.
- **DPDPA-compliant.** `pii_access_log` populating; data retention
  policies enforced; right-to-erasure procedure tested.
- **Filled gaps from the demo.** Approvals enforcement on requisitions
  and offers. JD builder with AI generation. Reminders agent.
  Additional ticket sub-surfaces if Kyndryl needs them.

---

## 2. The 8-week onboarding plan

### Week 1 — Tenant provisioning + SSO

**Goal:** Kyndryl admin can log in to production tenant via their IdP.

- Provision `kyndryl` production tenant (separate from `kyndryl-poc`
  demo tenant)
- SSO bridge for Kyndryl's IdP (likely SAML or OIDC — confirm in
  contract discussions)
- Kyndryl admin user(s) seeded and tested
- Branding assets received from Kyndryl (logo, colors, sending domain
  preferences)
- DNS for Kyndryl's apply-link and email-sending domains kicked off
- Workday sandbox access request initiated (Workday IT side often
  takes 2-3 weeks)

**Deliverable:** Kyndryl admin logs in to production tenant, sees empty
state, invites first wave of recruiters.

### Week 2 — Approvals enforcement

**Goal:** Approval matrices are real and enforced.

- tRPC procedures on existing approval schema (chains, requests,
  decisions, matrices)
- Admin UI for approval matrix configuration
- Enforcement hooks on requisition publish and offer extend
- Approver notification flow (email + in-portal + via agent surface)
- Rejection-with-reason flow + audit logging
- Kyndryl-specific matrix configured

**Deliverable:** Kyndryl-defined approval rules block req publish and
offer extend; rejection feedback flows through audit.

### Week 3 — JD builder + requisition creation

**Goal:** Recruiters can create requisitions in-product.

- JD builder UI with AI generation (per-section + version history) —
  schema exists from Wave 1
- Requisition creation wizard with budget alignment fields
- Requisition templates seeded with Kyndryl's common role bands
- Requisition state machine: draft → pending approval → published →
  closed
- Slug auto-generation + uniqueness already shipped — surface in UI

**Deliverable:** Recruiter creates a new req from scratch, AI-assists
the JD drafting, submits for approval, sees it published with apply
link.

### Week 4 — DPDPA compliance + reminders agent

**Goal:** Compliance commitments delivered; reminders agent extends the
wedge.

- `pii_access_log` table + middleware on every PII read (architecture
  §9.4 commitment)
- DPDPA retention policy enforcement (configurable per-tenant)
- Right-to-erasure procedure (admin-triggered) tested
- Reminders agent — extension of the follow-ups pattern from build
  weeks 6-7. New triggers (interviewer pre-panel, candidate pre-
  interview, recruiter stale-item digest). Same agent engine. Same
  approval queue.

**Deliverable:** Every PII access is logged; DSAR procedure works;
reminders fire correctly for at least three trigger types.

### Week 5 — Real Workday connector

**Goal:** Replace the simulator with real Workday SOAP integration.

- Real SOAP client against Kyndryl's Workday sandbox (assuming
  credentials arrived by week 4)
- Workday error handling, retry policies, dead-letter queue
- Workday tenant-specific payload mapping (Kyndryl-specific fields)
- Test Hire roundtrip end-to-end against sandbox
- `simulation_notes` field set to null for real connector responses
  (the marker is for simulations only)

**Deliverable:** First real Workday Hire roundtrip in Kyndryl's
sandbox. Recruiter can see real Workday response in `/admin/integrations`.

### Week 6 — Real e-signature

**Goal:** Replace click-is-acceptance with real e-sign.

- E-signature provider integration (DocuSign / Adobe Sign / Signzy —
  Kyndryl chooses)
- Offer-accept flow updated to invoke e-sign instead of name-match
- Signed document storage and retrieval
- E-sign event webhook handling (sent, viewed, signed, declined,
  expired)
- Audit trail integration

**Deliverable:** Offer extended via HireOps creates an e-sign
envelope; candidate signs; HireOps records signed-document URL and
status.

### Week 7 — Data migration + additional ticket surfaces

**Goal:** Kyndryl's existing pipeline migrated; remaining wedge
surfaces shipped.

- Data migration from Kyndryl's current ATS (scope depends entirely
  on what they're moving from — Greenhouse, internal system, or
  starting fresh)
- Seed Kyndryl's live requisitions
- Tickets agent — sub-surface (b) internal recruiter tasks. Recruiter
  task tracking with AI-suggested next actions. Builds on existing
  agent engine.
- Tickets agent — sub-surface (c) hiring manager intake. HM raises
  "I need a senior backend engineer" ticket, routes to recruiter,
  agent suggests req template + similar past hires.

**Deliverable:** Kyndryl's open reqs are in HireOps. Recruiter task
tracking works. HM intake flows to recruiter queue.

### Week 8 — Go-live rehearsal + bug-fix pass

**Goal:** Kyndryl signs off they're ready.

- Go-live rehearsal: Kyndryl recruiter walks through the flow end-to-
  end with their own data, real Workday sandbox, real e-sign, real
  email
- Bug-fix pass on whatever surfaces
- Backup/restore drill
- Incident runbook reviewed with Kyndryl IT
- On-call rotation defined (Mindssparc + Kyndryl)

**Deliverable:** Kyndryl signs off. First real candidates can be
pointed at HireOps.

---

## 3. Dependencies on Kyndryl

Items that block onboarding progress if delayed:

- **IdP details for SSO** (week 1) — protocol, metadata, test users
- **Workday sandbox credentials** (week 1 ask, week 5 use) — Workday IT
  often slow
- **E-signature provider preference** (week 4 decision, week 6 use)
- **Approval matrix structure** (week 2) — who approves what
- **Branding assets** (week 1) — logo, colors, sending domain
- **Apply-link and sending domains** (week 1)
- **Current ATS** (week 7) — what they're moving from
- **First-cohort requisitions** (week 7)
- **Legal/DPDPA sign-off on privacy page** (week 4-5)

All of these get raised in the contract discussions Rajesh and Lakshmi
lead. None should be a surprise in the onboarding week they're needed.

---

## 4. Risk register

### High risk

**Workday sandbox access delayed past week 5.** Workday IT operates on
their own timeline; 4-6 week lead time on sandbox provisioning is
common. Mitigation: kick off the access request in week 1, escalate
through Rajesh / Lakshmi by week 3 if no progress, fall back to
simulator-extended for go-live if necessary with explicit Kyndryl
acknowledgement.

**E-signature procurement timeline.** Enterprise e-sign contracts can
take weeks if Kyndryl doesn't have an existing agreement. Mitigation:
identify provider in week 1 of onboarding (during contract
discussions), start procurement immediately in parallel.

### Medium risk

**SSO IdP edge cases.** Supabase Auth's enterprise SSO support varies
by IdP. Mitigation: confirm Kyndryl's IdP at contract sign, prototype
the bridge in week 1, escalate if Supabase coverage is inadequate
(may require custom OIDC layer).

**Approval matrix complexity.** Multi-level conditional rules ("offers
above ₹X require VP, offers in restricted geos need compliance") can
exceed week 2 scope. Mitigation: scope a v0 for linear chains in week
2, defer complex conditional logic to onboarding buffer or post-POC if
their matrix demands it.

### Low risk

**Data migration scope.** Depends on Kyndryl's current ATS. If
Greenhouse or Workday Recruiting, established export paths exist. If
homegrown, custom work. Mitigation: ask at contract sign so we know
what week 7 looks like.

---

## 5. What success looks like end of week 8

- Kyndryl production tenant live, SSO working
- First cohort of requisitions published
- Real Kyndryl recruiter takes a real candidate from apply through to
  hired-in-Workday using real Workday sandbox, real e-sign, real
  emails
- All five wedge surfaces working in production (scheduling, follow-
  ups, reminders, candidate Q&A, recruiter tasks, HM intake)
- `pii_access_log` populating, DPDPA controls verified
- Approval matrix configured and enforced
- Kyndryl IT signed off on SSO + DPDPA + integration security
- Go-live runbook exists, on-call defined

If we hit this, the relationship moves to steady-state support + Tier 2
feature buildout. If we miss, we extend onboarding into a 9th or 10th
week and communicate honestly.

---

## 6. What's deliberately not in onboarding scope

Each is in `post-poc-roadmap.md` (forthcoming, separate doc to be
written after demo lands). Stays out of onboarding to keep the timeline
realistic:

- Partner Portal (full feature set — schema is shipped, UI is months
  of work)
- Candidate Portal (status tracker, document upload, messaging)
- Interview operations (post-interview AI summary, transcript
  analysis)
- Real captions / translation in interview flow
- Bias detection rules CRUD + thresholds
- AI model + temperature configuration UI
- Theme & Branding full white-labelling (basic branding ships in week
  1; advanced options post-POC)
- Users & Roles full management UI (basic seeding ships in week 1;
  full CRUD post-POC)
- Documents & Verification (post-POC)
- HR Cases workflow (post-POC)
- Multi-channel sourcing — LinkedIn, Naukri, Indeed (post-POC)
- Market Intelligence (post-POC, vendor procurement required)
- BGV integrations (post-POC, provider-specific)
- Onboarding flow (Day 1 to Day 30) — adjacent product
- Offboarding flow — adjacent product
- Careers site SEO-indexed listings (post-POC)
- AI Voice Agent for phone screening (post-POC)
- Candidate AI Coach (separate product line discussion, not feature)

---

## 7. Pricing and commercial structure

Not in this document — that's the contract Rajesh and Lakshmi negotiate.
Flagged here only because pricing affects pacing:

- If the POC is fixed-price for the 8-week onboarding, scope discipline
  is critical — anything Kyndryl asks for outside §2 becomes paid
  scope-change or post-POC roadmap.
- If the POC is time-and-materials, more flexibility on adding scope
  but the team needs to track actual hours honestly.
- If the POC is funding-the-build (Kyndryl as anchor for the multi-
  month build), the post-POC roadmap conversation becomes more
  collaborative — Kyndryl shapes Tier 2 priorities.

Whichever structure, the build plan and this onboarding scope are
written assuming Kyndryl is committed for the duration. If the
commitment is shorter, the plan shortens accordingly.

---

## 8. Out of scope for this document

- The pre-demo 13-week build → `build-plan-13week.md`
- The demo itself → `demo-scope-v2.md`
- Long-term roadmap beyond onboarding → to be written after demo
  lands, against Kyndryl's actual feedback
