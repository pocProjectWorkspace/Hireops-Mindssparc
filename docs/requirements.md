# HireOps — Product Requirements

**Version:** 0.1 (POC scoping draft)
**Date:** 8 May 2026
**Audience:** Internal product + engineering, Kyndryl GCC stakeholders
**Context:** HireOps is a multi-tenant SaaS ATS for enterprise hirers, with full lifecycle coverage (recruitment + onboarding + offboarding) and Workday as the customer-side HRIS-of-record where applicable. **Kyndryl's GCC is the first POC customer**, funding the initial platform build and serving as launch design partner — 300 hires/month for 12 months (3,600 hires/year) at production volumes; **sourcing model: ~60% via HR partners (mix of empanelled vendors and ad-hoc agencies), ~25% direct (career site, inbound), ~15% referrals.** Partner portal is a first-class capability of the platform. On successful POC, Kyndryl becomes Tenant #1 in production and additional enterprise tenants follow.

---

## 1. How to read this document

The Lovable codebase has 78 pages across 7 personas. Most of them describe a recognisable enterprise ATS, but they were generated to demonstrate ideas — not to operate at the volume Kyndryl needs. This document does three things:

1. **Re-frames the product around real workflows**, not Lovable's screen taxonomy. A page is not a feature; a feature is something that produces a measurable outcome (a hire, an offer accepted, a candidate informed, a Workday worker created).
2. **Goes through every Lovable feature** and marks it Keep / Modify / Drop / Missing, with reasoning grounded in the 300/month workload.
3. **Flags everything Lovable never covered** — sourcing channels, BGV, compliance, IT provisioning, asset management, exit workflows, observability, bulk operations, etc.

Where Kyndryl-specific context matters (volume, geography, Workday, GCC-specific compliance) it is called out inline. Read those callouts as launch-customer design constraints — they shape the product for Tenant #1 and validate it for Tenant #N.

---

## 1.5 Product positioning

HireOps is a multi-tenant SaaS platform for enterprise hiring. The product is sold to enterprises that run their own hiring at scale — typically Global Capability Centers (GCCs), Indian enterprises, and SE-Asian high-volume hirers. Each customer becomes a tenant on shared platform infrastructure, isolated from other tenants by `tenant_id`-scoped row-level security and per-tenant integration credentials. The closest comparables are Ashby and Greenhouse, not Workday — one product, one codebase, one production deployment, many tenants.

The current build is funded by a paid POC engagement with Kyndryl's GCC. That engagement validates the platform end-to-end — recruitment, onboarding, offboarding, Workday integration, partner ecosystem — at production volumes (300 hires/month). On successful POC, Kyndryl becomes the first paying production customer (Tenant #1) and the platform is then sold to additional enterprise customers. Subsequent tenants follow the same onboarding flow without code changes.

All product decisions in this document are made by the HireOps team as the platform vendor. Customer-specific concerns — Kyndryl's choice of SSO, BGV vendor, approval matrix, partner panel composition, MSA template — are handled through tenant-onboarding configuration, not through bespoke development. Where a customer's needs cannot be met by configuration, the platform is extended with new configurability for everyone, never with one-off customer code.

The Multi-Tenancy ADR (forthcoming, ADR-002) is the architectural decision-of-record for how tenant isolation, configuration, integration credential management, and tenant onboarding work. Until that ADR lands, this document and `architecture.md` describe the platform as if Kyndryl were the only tenant; that simplification is removed once the ADR ships, at which point every domain entity carries `tenant_id` and every read/write is scoped accordingly.

---

## 2. The core constraint Kyndryl creates

300 hires/month is roughly **15 hires per working day**. For a typical IT-services GCC the funnel from applied → hired sits at 30:1 to 50:1, so the system must comfortably handle:

- ~9,000–15,000 new applications per month (~450–750/day)
- **Of these, ~60% (~5,400–9,000/month) come through HR partners** — bulk-submitted by 20–30 empanelled vendors plus a long tail of ad-hoc agencies
- ~1,500 interviews per month (~75/day, peak ~150/day)
- ~600 offers in flight at any time
- ~50–80 concurrent recruiters and ~200+ panel members across IST working hours
- **~150–300 concurrent partner users across all empanelled agencies**
- ~3,600 onboarding journeys per year, with 30–60 in active "Day 1 to Day 30" state at any moment
- ~10–20% annual attrition assumption → ~400–700 offboarding cases per year

This is a real production system, not a prototype. **Every requirement below is tested against "does this hold up at that volume?"**

The Lovable code, as audited, is built to render mock data for ~10–20 candidates per page. It will not survive contact with real volume without a serious data-layer build-out.

---

## 3. Personas — what changes from Lovable

Lovable defines 7 personas: `requirement_owner`, `hr_head`, `recruiter`, `panel`, `hr_team`, `candidate`, `admin`. For Kyndryl's full lifecycle, this is incomplete.

### 3.1 Personas to keep as-is (with refinement)

| Persona | Lovable scope | What changes for Kyndryl |
|---|---|---|
| **Recruiter (TA Specialist)** | Sourcing, candidate management, interview coordination | Add bulk operations (move 50 candidates between stages, bulk-message, bulk-reject with reason codes). At 300/month one recruiter handles ~30–60 candidates simultaneously — UI must support that density. |
| **Requirement Owner (Hiring Manager)** | Creates JDs, reviews candidates, gives approval | Likely a Kyndryl delivery manager / engagement manager. Light-touch user — fewer than 5 minutes per candidate review. Mobile-first reality. |
| **Interview Panel** | Scorecards, candidate briefs, feedback | At 300/month, panel utilization is the bottleneck. Need panel-load balancing and SLA tracking on feedback submission (currently absent). |
| **Candidate** | Apply, track, AI assistant, attend interview | The most-touched persona. Critical for NPS and offer-acceptance rate. |
| **Admin** | Settings, integrations, governance | Becomes more important — config-as-code for hiring workflows, role permissions, integration credentials. |

**Mobile interaction budgets.** Hiring manager and Interview Panel personas have mobile as a primary surface. The platform commits to: P95 page load < 2s on a representative 4G connection (Mumbai/Bangalore baseline; we measure against ~10 Mbps down with ~80ms RTT); core workflows (review candidate / approve req / submit feedback / accept-reject offer) reachable in ≤ 5 taps from email or in-app notification entry; viewport target 375px minimum width; touch targets ≥ 44x44px per Apple HIG. Recruiter persona is desktop-first and exempt from these budgets.

### 3.2 Personas to restructure

| Lovable persona | Issue | Recommendation |
|---|---|---|
| **HR Head** | One persona doing approvals, market intelligence, governance, audit, analytics, cost-per-hire across 9 pages — that's 3 jobs. | Split into **Talent Acquisition Lead** (operational: pipeline health, recruiter performance, SLA breaches) and **HR Director** (strategic: market intelligence, cost-per-hire, governance, audit). For POC, ship as one persona with role-based view toggles; split later. |
| **HR Team** | Currently does HR rounds, comp/offers, document verification — i.e. the "back-half" of recruitment. | Rename to **HR Operations** and absorb the new lifecycle scope (BGV coordination, onboarding kickoff, exit interview). |

### 3.3 New personas required for full lifecycle

| Persona | Why needed | Core surface |
|---|---|---|
| **People Ops / Onboarding Specialist** | Owns Day -7 to Day 30 of new hire lifecycle. Distinct from recruitment. | Onboarding case board, IT provisioning status, document collection tracker, manager handoff confirmations, probation tracking. |
| **IT / Workplace Services** | Owns laptop provisioning, software licences, badge access, deprovisioning on exit. | Asset register, provisioning queue, deprovisioning queue, integration health (Okta/AD/Jira/etc.). |
| **HR Partner (external sourcing agency)** | Single biggest source of candidate flow for GCC ramps. 50–70% of submissions in IN/PH GCCs come through partners. Two tiers: **empanelled** (MSA-bound, full portal access) and **ad-hoc** (email-only intake, no portal). | Partner portal: own dashboard, open reqs they're empanelled for, candidate submission, pipeline visibility for their candidates, commercial tracking, communication with their candidates. |
| **Background Verification Vendor (external)** | Read-only candidate context + write-only verification outcomes. | API-only persona — no UI. Webhook-fed status updates. |
| **Hiring Approver Chain** | Workday integration: org-level approvals for headcount, offers above grade, NPS-impacting decisions. | Lightweight inbox view: approve / reject with comment. Often mobile. |
| **Employee (post-hire)** | Once onboarded, the candidate becomes an employee with ongoing rights: data access, exit initiation, document downloads. | Carries forward the candidate portal, with extended scope for active employees. |
| **Platform admin (HireOps internal staff)** | Provisions tenants, monitors cross-tenant platform health, runs support escalations. **Out of scope as a tenant-facing persona** — they are HireOps staff, not customer users — but called out here so it's clear the platform has cross-tenant operational surfaces. | Cross-tenant ops dashboard, tenant provisioning UI, tenant suspension / deletion controls. Detailed in `multi-tenancy-adr.md` §5.6 and the (forthcoming) ops runbook, not in this document. |

**Final tenant-facing persona count: 13.** Lovable's 7 (recruiter, requirement_owner, hr_head, hr_team, panel, candidate, admin) plus the 6 net-new tenant-facing personas defined in §3.3 (People Ops, IT/Workplace Services, HR Partner, BGV Vendor, Hiring Approver Chain, Employee). A 14th platform-admin persona exists (HireOps internal staff for cross-tenant ops) but is out of scope for this document — see the row above for context. This is significantly more than Lovable's 7 but it is honest about the actual operating reality of a GCC at this scale. The HR Partner persona alone may carry more daily user load than any internal persona — at 60% of 9,000 monthly applications, that's ~5,500 partner-side submissions/month spread across 20-30 partner organisations.

---

## 4. Lifecycle stages — the canonical state machine

This is the single most important diagram in the doc. Every screen, every workflow, every database table maps to a stage transition here.

```
┌──────────────────── SOURCING CHANNELS ──────────────────────┐
│                                                              │
│  Direct apply         Empanelled        Ad-hoc partner      │
│  (career site,    +   partner       +   (email-intake,      │
│   referral,           submission         CV parsing)        │
│   inbound)            (portal)                              │
│                                                              │
│  Agency search        LinkedIn /         Talent pool        │
│  (recruiter       +   Naukri /       +   (silver-medallist, │
│   outreach)           Indeed             post-Wave-1)       │
│                                                              │
│           ↓ Dedup + Ownership claim ↓                       │
└──────────────────────────────────────────────────────────────┘
                         ↓
┌──────────────────── RECRUITMENT ────────────────────┐
│                                                      │
│  Headcount        Requisition    JD        Posted   │
│  Approved    →    Created    →   Approved  →  Live  │
│                                                      │
│  Application    AI Screen     Recruiter             │
│  Received    →  & Score    →  Shortlist             │
│                                                      │
│  Tech         HR        Offer       Offer           │
│  Interview →  Round  →  Drafted →   Accepted        │
│                                                      │
│  → Partner ownership locked at offer-accept date    │
│    (drives fee attribution)                          │
└──────────────────────────────────────────────────────┘
                         ↓
┌──────────────────── ONBOARDING ───────────────────────┐
│                                                        │
│  Pre-board     BGV         Document                   │
│  Initiated  →  Cleared  →  Collected                  │
│                              ↓                         │
│  Workday Pre-Hire   (auto-fired on offer-accept)      │
│                              ↓                         │
│                            Workday Hire   (auto-fired │
│                                            on Day 1)  │
│                              ↓                         │
│  IT            Day 1       30-Day       Probation     │
│  Provisioned → Welcome  →  Check-in  →  Confirmed     │
│                                                        │
│  → ACTIVE EMPLOYEE                                     │
│  → Partner fee invoice eligible (post-probation)      │
└────────────────────────────────────────────────────────┘
                         ↓
                   (months / years)
                         ↓
┌──────────────────── OFFBOARDING ────────────────────┐
│                                                      │
│  Resignation   Notice      Knowledge    Exit        │
│  Initiated  →  Period   →  Transfer  →  Interview   │
│                                                      │
│  Asset         Access      F&F          Workday     │
│  Returned   →  Revoked  →  Settled  →   Terminate   │
│                                                      │
│  → ALUMNI                                            │
│  → Partner fee clawback if pre-probation departure  │
└──────────────────────────────────────────────────────┘
```

Every stage transition is auditable. Every transition has an SLA. Every transition has a responsible persona. Every transition is a state machine row in the database. **Partner ownership and fee attribution sit alongside the lifecycle, not inside it** — they're a parallel ledger that locks at offer-accept and reconciles at probation-pass.

---

## 5. Recruitment requirements

### 5.1 Headcount & requisition management

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| Headcount approval (separate from req) | ❌ Missing | Annual or quarterly headcount must be approved as a budget envelope **before** requisitions are created against it. Requisition creation deducts from envelope. | **Missing — required.** |
| Requisition creation | ✅ Present | Must support cloning, bulk creation (10+ at once for similar roles — common in GCC ramp-ups), templated requisitions per role family. | **Modify.** |
| Multi-level approval workflow | ✅ Present (single chain) | Configurable: HM → TA Lead → Finance → CHRO depending on grade/cost. Workday-linked (some approvals may originate in Workday). | **Modify.** |
| Requisition vs Position | ❌ Confused | Workday distinguishes "Position" (a slot in the org chart) from "Requisition" (open hiring for that slot). HireOps must respect this — every hire ultimately creates or fills a Workday Position. | **Missing — critical.** |
| Bulk requisition creation | ❌ Missing | At GCC ramp scale, opening 30 reqs in one go is normal. Must support CSV upload / template instantiation. | **Missing — required.** |
| Requisition state machine | ⚠️ Partial | States: draft, pending_approval, approved, on_hold, posted, filled, cancelled, closed. Each transition logged. | **Modify.** |

### 5.2 Job description authoring

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| AI JD generation | ✅ Present (Lovable AI Gateway) | Replace Lovable Gateway with direct Anthropic / OpenAI / Bedrock calls. Add prompt versioning. | **Keep, modify infra.** |
| JD library / templates | ✅ Present | Must support Kyndryl role taxonomy. Versioning per JD. | **Keep.** |
| JD quality / bias scanner | ✅ Present | Decent — uses LLM. Add explicit gendered-language and protected-characteristics check. | **Keep, harden.** |
| Multi-language JD output | ❌ Missing | Kyndryl GCC is global — JDs may need EN + local language. Even India sometimes. | **Missing — nice-to-have for POC.** |
| JD external posting | ⚠️ Implied, not built | Must publish to LinkedIn, Naukri, Indeed, Kyndryl careers site. Posting + take-down + status sync. | **Missing — required.** |

### 5.3 Sourcing & candidate intake

This is where Lovable is weakest. The mock data has candidates magically appearing in the pipeline. Real ATS work is 60% sourcing.

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| Job-board posting & sync (LinkedIn, Naukri, Indeed) | ❌ Missing | Multi-board posting, applicant pull, dedup against existing candidates. | **Missing — critical.** |
| Career site (Kyndryl-branded apply page) | ❌ Missing | Public-facing, mobile-first apply form. Resume parsing on submit. CAPTCHA, rate limiting, GDPR/DPDPA consent. | **Missing — critical.** |
| Resume parsing | ❌ Missing | LLM-based parser → structured candidate record. Support PDF, DOCX, image-based scans (OCR). **Accuracy threshold:** parser correctly extracts name + email + phone + total years of experience + primary skills on **≥ 95% of representative Indian CV corpus** (curated test set of 100 CVs spanning fancy designer formats, single-column, two-column, table-heavy, image-heavy). Edge-case formats (vertical layouts, scanned poor-resolution PDFs, non-English content) route to a manual edit flow rather than block submission. Parser quality is monitored continuously; weekly quality report surfaces drift. | **Missing — critical.** |
| Email-to-apply (forward resumes to a mailbox) | ❌ Missing | Common in IN/PH GCC sourcing — agency partners email resumes. | **Missing — required.** |
| Referral programme | ❌ Missing | Internal referral submission, tracking, payout workflow. **In partner-heavy GCC contexts (like Kyndryl's, where partners are ~60% of flow), referrals typically account for 15–20% of hires** rather than the 30–40% seen in non-partner-heavy environments. Wave 1 ships a minimal "submit a referral" form (employee → application with `source='referral'` + referrer_id); the full programme infrastructure (payout workflow, leaderboards, gamification) is Phase 2. | **Missing — Phase 2.** |
| Agency / HR partner portal | ❌ Missing | Empanelled partners submit CVs against reqs, track pipeline, see commercials. **See Section 6 for full requirements** — this is now treated as a first-class capability and Wave 1 in-scope rather than a Phase 2 nice-to-have. | **Missing — P0 for POC.** |
| Talent pool / silver-medallist recontact | ❌ Missing | DPDPA-relevant: requires explicit consent. Rejected-but-strong candidates re-engaged for future roles. | **Missing — Phase 2.** |
| Candidate dedup | ❌ Missing | Same person applies via 3 channels — must be merged. Email + phone + name fuzzy match. **Dedup runs synchronously on every submission, before the application row is committed.** Atomic INSERT ... ON CONFLICT against the partial-unique index on `candidate_ownership_claims (tenant_id, person_id, requisition_id) WHERE status = 'active'` (per `architecture.md` §7.4 and `partner-data-model.md`). Blocking dedup is acceptable because the operation is sub-100ms; eventual consistency is not — partner ownership disputes cost more than the latency cost of synchronous checks. | **Missing — critical.** |
| WhatsApp / SMS apply | ✅ Partial (WhatsApp infra) | Lovable has WhatsApp infrastructure but no apply flow built. Worth completing — IN/PH candidates respond to WhatsApp at 4–10x email rates. | **Modify.** |

### 5.3a Recruiter intake & triage

The §5.3 sourcing requirements describe how applications enter HireOps. This sub-section covers what happens on the recruiter side once they land. The Lovable code mocks a populated pipeline; in reality, every new application is an event that needs routing, ack, and a human decision within an SLA.

**Notification on application creation.** Every new `applications` row fires a notification to the recruiter currently assigned to the parent req. Channels: in-app (bell + dashboard "needs attention" tile) plus email digest. Real-time notification is preferred for partner-submitted candidates (which carry a fee clock) and for candidates whose AI score is in the top band. Lower-band direct applications can batch into a daily digest to avoid drowning the recruiter at 450–750 daily applications.

**Default assignment rule.** Applications inherit the recruiter assigned to the req at the moment of req posting. Reassignment is supported (recruiter rotation, leave coverage) but every reassignment is logged in `audit_logs` with actor, target, reason. Multi-assignment (a "team" of recruiters on one req) is allowed; notifications fire to all assignees but the SLA clock attaches to the primary.

**Triage SLA.** Recruiter must take a triage decision (accept-into-pipeline / reject-with-reason / route-to-other-recruiter) within **24 working hours** of application creation. SLA breach is surfaced on the recruiter dashboard, the TA Lead's pipeline-health view, and the partner-side dashboard if applicable (the partner sees "awaiting screen >5 days" exactly because this SLA exists). Triage decisions are themselves auditable state transitions.

**Bulk triage.** Out of scope for Wave 1. Wave 1 ships single-record triage only. Bulk move/reject/message lands in Wave 2 per `requirements.md` §11 and §9.6.

### 5.4 Screening & shortlisting

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| AI candidate scoring | ✅ Present (mocked) | Real implementation: weighted skill match against JD, resume-vs-JD semantic match, experience alignment. Score ∈ [0, 100]. **Quality gate:** AI score must correlate with eventual hire decisions at Spearman rho ≥ 0.4 on a calibration set of ≥ 200 historical hires per role family. AI's top-decile must rank in the top quintile of human-graded candidates with precision ≥ 0.7. Below these thresholds the score is surfaced as advisory only (not a primary sort key). | **Keep, build for real.** |
| Bias shield / fairness check | ✅ Present (UI only) | Must produce **auditable** fairness reports (selection rate by protected characteristic — DPDPA requires fairness, EEOC analogue if Kyndryl serves US). | **Keep, harden.** |
| Skill weighting | ✅ Present | Per-role weights set by HM. Must persist in `jd_skills`. | **Keep.** |
| Recruiter shortlist | ✅ Present | Must support bulk actions, filtering by score band, score-ordered view with quick reject reasons. | **Keep, harden for volume.** |
| AI explanation per score | ⚠️ Partial | Each score must have a "why" — top 3 contributing factors. Required for fairness defence. | **Modify.** |
| Knockout questions | ❌ Missing | Notice period > 30 days? Visa status? Compensation expectation? Auto-reject if knockout fails. | **Missing — required.** |

### 5.5 Interviewing

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| Interview scheduling | ✅ Present (UI only) | Real calendar integration (Google + Outlook), panel availability matching, candidate self-service slot picking. At 75 interviews/day, manual scheduling kills the recruiter. | **Modify — critical.** |
| Panel composition | ✅ Present | Must support panel pool with skill tags, load balancing, "this panellist did 4 interviews this week, route to someone else." | **Modify.** |
| Built-in video room | ✅ Present (UI) | Lovable has UI shells but no actual WebRTC. **Decision required**: build (3–4 weeks) or integrate Zoom/Teams (1–2 weeks). For POC, integrate Zoom/Teams. | **Modify — pragmatic decision.** |
| Interview recording + transcript | ✅ Present (UI) | Real implementation: Zoom/Teams recording + Whisper or Google Speech-to-Text → LLM summary. | **Modify.** |
| Live coding / take-home assessments | ❌ Missing | For tech roles — HackerRank, CodeSignal integration or simple in-house. | **Missing — required for tech roles.** |
| Structured scorecards | ✅ Present | Kyndryl will define evaluation rubric per role family. Must be configurable. | **Keep, modify for config.** |
| Feedback SLA tracking | ❌ Missing | If feedback isn't in within 24h, recruiter is blocked. Must surface this. | **Missing — required.** |
| Panel calibration view | ❌ Missing | Same panellist's scoring tendency over time — to detect drift / outliers. | **Missing — Phase 2.** |

### 5.6 Offers & pre-onboarding

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| Offer generation | ✅ Present | Must produce a Workday-compatible offer record with grade, comp band, location, start date. PDF generation for candidate signature. | **Modify.** |
| Comp recommendation | ✅ Present (mocked) | Wave 1/2 implementation: tenant-configured benchmarks (uploaded salary bands per role family per location, refreshed by tenant admin) + internal equity check (recent hires in same role/grade within tenant) + budget envelope check (against `headcount_envelopes`). **Third-party market data feeds (Mercer, Aon, Glassdoor APIs) are Phase 2** — they require tenant-side commercial agreements with the data provider and are not part of POC scope. | **Modify.** |
| Multi-level offer approval | ✅ Present | Same as requisition approval — configurable, role-based. | **Keep.** |
| Offer letter e-signature | ❌ Missing | DocuSign / Adobe Sign integration. Cannot be PDF download + scan in 2026. | **Missing — required.** |
| Counter-offer / negotiation log | ⚠️ Partial | Audit trail of comp negotiation. Important for DPDPA + dispute defence. | **Modify.** |
| Offer-to-Workday handoff | ❌ Missing | The defining moment of HireOps→Workday integration. Once offer accepted, create Workday Pre-Hire record. | **Missing — critical.** |

---

## 6. HR Partner sourcing requirements (entirely missing in Lovable)

This is the largest single gap between Lovable's design and what Kyndryl actually needs. **Partner sourcing is the dominant channel for GCC hiring** — Kyndryl's ramp is impossible without it. The Lovable code has zero partner concept.

### 6.1 Two tiers of partner

Kyndryl's setup ("mix of empanelled and ad-hoc") is the pragmatic real-world model. Each tier has different access, different commercials, different trust.

| Tier | Description | Volume | Platform access |
|---|---|---|---|
| **Empanelled** | Master Service Agreement with Kyndryl. Defined commercials, SLA commitments, exclusivity terms. Typically 15-30 vendors. | ~80% of partner-sourced flow | Full partner portal: dedicated logins, dashboard, req visibility, pipeline tracking, commercials view, candidate communication |
| **Ad-hoc** | No MSA. Spot vendors used opportunistically, sometimes for niche skills. Could be 50-100+ vendors in a tail. | ~20% of partner-sourced flow | Email-only intake. They mail CVs to a Kyndryl-managed mailbox; HireOps parses inbound emails and creates candidate records with the source partner attribution. No login. No portal. No pipeline visibility. |

The distinction matters because empanelled partners have legal accountability for the candidates they submit (DPDPA consent attestation, accuracy of CV, no double-submission across competitors). Ad-hoc partners have weaker accountability so the platform must compensate with stronger downstream controls.

### 6.2 Partner workflows (for empanelled, full-portal)

| Capability | Required behaviour |
|---|---|
| Login | Separate auth tier — partners do **not** SSO via Kyndryl IdP. Magic-link or password + MFA. Account provisioning is admin-driven (Kyndryl admin invites a partner organisation; that org's admin then invites their own recruiters). |
| Partner organisation hierarchy | Partner org → Partner admin → Partner recruiters. Partner admin manages their team's access and sees aggregate metrics. |
| Open reqs view | List of reqs the partner is empanelled to source for. Partner does NOT see all reqs — only those Kyndryl has explicitly opened to them. Filtered by skill / location / urgency. |
| Submit candidate against req | Upload CV (PDF/DOC), enter or auto-extract candidate details, attest DPDPA consent, optionally add a partner note. Submission triggers ownership claim. |
| Speculative submission ("talent pool" lane) | Partners can submit candidates without a specific req, tagged by skill profile. These land in a **separate** holding queue, not the active pipeline. Recruiter pulls from talent pool when matching reqs open. |
| Bulk submission | Upload 5-50 CVs at once — common for narrowly-defined ramps. Each gets its own ownership claim. |
| Pipeline visibility (own candidates only) | Partner sees the stage of every candidate they submitted: submitted → screened → interview-1 → interview-2 → offer → hired (or rejected at any stage). They see stage and date, **not** the reasons or feedback notes. |
| Stage-change notifications | Email/WhatsApp to partner when their candidate moves stage. Configurable. |
| Communication with candidates | Partner can message their own candidates through the platform — but only their own. Messages are logged, monitored for non-compete language, and Kyndryl recruiters can audit. |
| Commercials dashboard | Visible to partner admin only: candidates submitted, candidates in pipeline, candidates hired, fees earned, fees pending invoice, fees disputed, payment status. |
| SLA / quality metrics dashboard | Submission acceptance rate, screen-pass rate, hire rate, time-to-submit-after-req-open. Kyndryl uses this to manage the partner panel. |
| Document download | Partner can download their submitted CV (audit copy), their attested consent record, their commercial terms. They cannot download Kyndryl-internal feedback or scoring. |

### 6.3 Workflows partners must NOT have

| Restriction | Why |
|---|---|
| Cannot see other partners' submissions | Standard agency confidentiality; prevents partners gaming volume signals |
| Cannot see Kyndryl-direct candidate submissions | Same |
| Cannot see internal feedback or AI scoring rationale | Risk of leaking interview content; risk of coaching candidates against rubric |
| Cannot see other reqs they're not empanelled for | Confidentiality of upcoming hiring plans |
| Cannot see Kyndryl-internal users' identities (panel members, hiring managers) | Reduces poaching, reduces social-engineering attack surface |
| Cannot edit a candidate record after submission | Once submitted, immutable (only Kyndryl can edit). Prevents post-hoc CV tampering. |
| Cannot withdraw a candidate to re-submit through another route | Prevents double-counting / fee manipulation |
| Cannot communicate with a candidate after they accept an offer | Prevents poaching at the offer stage |

### 6.4 Candidate ownership & fee attribution — the rules

This is the single most disputed area in agency-led hiring. Get this wrong and Kyndryl pays double fees, partners sue, recruiters disengage. The model below is the industry standard with refinements.

**Core rule:** First valid submission wins. Exclusivity windows: **90 days for req-bound submissions, 180 days for speculative submissions**, per candidate. **By default, ownership applies to the candidate at Kyndryl during the active window** — meaning if the candidate is hired into a different req at Kyndryl while the window is active, the original partner is still entitled to the fee. MSAs MAY narrow this default to attribute only to the originally-submitted req; this is an MSA-driven configuration, not the platform default.

Throughout this section, "the window" refers to the applicable window for the submission type (90 for req-bound, 180 for speculative). Ad-hoc partner submissions use a shorter **60-day window** (see edge-case row "Empanelled partner A submits → ownership lapses → ad-hoc agency emails same CV..." below).

#### What "valid submission" means

A submission is valid only if **all** the following hold:

1. CV uploaded with parseable contact details (name, phone, email)
2. DPDPA consent attestation present and accepted
3. Candidate not already in HireOps via any other route (Kyndryl-direct, another partner, or earlier-in-window submission from same partner)
4. Submitted against an open req that the partner is empanelled for, OR submitted to the speculative talent pool with skill tags

Submissions that fail any of these are rejected with a clear reason code. They do not count for ownership.

#### What ownership grants

If Partner A's submission of Candidate X against Req R is the first valid submission (req-bound case; for speculative, swap "Req R" for "talent pool" and "90 days" for "180 days"):

- **Partner A owns Candidate X for 90 days from submission date** (180 days for speculative).
- If Candidate X is hired into Req R during the active window — by **any** path (partner submission, direct application, recruiter outreach, referral) — Partner A is entitled to the placement fee per their MSA.
- If Candidate X is hired into a **different req** at Kyndryl during the active window, the default fee attribution still goes to Partner A (consistent with the core rule above). An MSA MAY override this default to limit attribution to the originally-submitted req — surfaced via `partner_msa.exclusivity_scope = 'req_only'` per `architecture.md` §7.8.
- If Candidate X is rejected for Req R but is still active at Kyndryl elsewhere within the active window, ownership stays with Partner A.

#### When ownership lapses

- The applicable window from submission with no hire (90 days req-bound, 180 days speculative, 60 days ad-hoc) elapses: lapses. Candidate becomes fair game for re-submission by any partner or for direct sourcing without fee attribution to Partner A.
- Candidate explicitly opts out: lapses (DPDPA right). No fee.
- Partner withdraws the candidate or breaches MSA: lapses, with audit trail.

#### Edge cases — coded as data rules, not human judgement

| Scenario | Resolution |
|---|---|
| Two partners submit same candidate within seconds | Database timestamp wins, with millisecond resolution. Loser sees a "candidate already submitted" message and their submission is recorded for audit but not counted. |
| Candidate previously rejected from Kyndryl 6 months ago, now re-submitted by Partner B | If the prior submission's applicable window (90 / 180 / 60) has lapsed, Partner B gets fresh ownership. After 6 months, the prior partner's window has long expired regardless of submission type, so Partner B gets fresh ownership. |
| Candidate self-applied directly 30 days before any partner submission | Direct application creates a record but no ownership claim (no fee owed). If a partner subsequently submits the same candidate, the partner's submission is **invalidated** because the candidate is already in HireOps. Direct-applied candidates are protected from retroactive partner claims. |
| Partner submits same candidate to two different reqs simultaneously | Allowed. Each submission is tracked separately; ownership applies to whichever req results in hire first. |
| Candidate applies directly while in an active partner ownership window | Partner ownership stands; direct application is logged but does not displace partner. |
| Empanelled partner A submits → ownership lapses → ad-hoc agency emails same CV → HireOps re-creates dedup-matched record | Ad-hoc submissions DO create ownership claims (consistent with §6.5 and `partner-wireflows.md` §4.1), but with: (a) a 60-day window (shorter than empanelled 90-day, recognising lower MSA backing), (b) fee per `ad_hoc_partners.default_fee_terms` with no holdback, (c) ad-hoc claims lose to empanelled claims in disputes when both are within window. |
| Disputed ownership (partners disagree) | Manual review queue. Kyndryl admin sees full submission history with timestamps and resolves with audit trail. Default ruling: timestamp wins; in mixed empanelled/ad-hoc disputes, empanelled wins regardless of timestamp. |
| Candidate submitted to a req that gets cancelled | Ownership transfers to the speculative talent pool **with the window reset to 180 days from the original submission date.** This always gives the partner more time than the remaining 90-day req-bound window, so no special-case logic is needed — the speculative window simply replaces the req-bound window. |

#### Non-disclosure of ownership status to other partners

Other partners attempting to submit the same candidate are not told **who** owns the candidate. They see only "candidate already in pipeline." This protects partner confidentiality.

### 6.5 Ad-hoc partner intake (email-based)

For partners without portal access:

1. Kyndryl operates **per-req email aliases**: `cvs-{req-id}@kyndryl-hireops.com`, plus `cvs-talent-pool@kyndryl-hireops.com` for speculative ad-hoc submissions. Partner attribution comes from sender-domain lookup against the `ad_hoc_partners` registered domain list — not from the recipient mailbox. Per-req aliases auto-expire when the req closes.
2. Inbound email is parsed by an ingest worker:
   - Extract CVs from attachments (PDF/DOC/DOCX)
   - Extract subject line / body for candidate name, contact info, and any optional consent attestation language
   - Identify partner from the sender domain
   - Resume-parser fills in the rest
3. Each parsed candidate creates a record with `source_partner_id` resolved from the sender-domain lookup.
4. The req binding comes from the recipient alias: a `cvs-{req-id}@…` mail routes to that req; `cvs-talent-pool@…` routes to the talent pool.
5. Same dedup + ownership rules apply (per §6.4 the ad-hoc window is 60 days), and ad-hoc partners get **a flat reduced fee** per `ad_hoc_partners.default_fee_terms` (or no fee, depending on the registered terms — most ad-hoc engagements are pay-per-hire-only with lower rates). No holdback applies to ad-hoc fees.

### 6.6 Communication guardrails

Partner-to-candidate communication is necessary (partners coach their candidates, prep them for interviews, manage logistics) but is also the highest-risk surface for misuse. Required controls:

- All messages logged in HireOps, viewable by Kyndryl admin
- Outbound messages from partner go through HireOps (not partner's own email) to enforce logging
- Inbound replies route back through HireOps, displayed to partner without leaking candidate's actual email
- LLM-based content scanner flags messages containing: alternative job offers, references to competing employers, requests for personal contact info outside the platform, derogatory references to Kyndryl. **Quality thresholds:** scanner achieves **precision ≥ 0.85 and recall ≥ 0.7** on the calibration corpus (curated set of representative partner-candidate exchanges). Precision is the priority — false positives erode partner trust faster than false negatives miss abuse. Flagged messages route to a Kyndryl-admin review queue; the partner is notified that a message is held for review without being told the specific flag reason. Calibration corpus is reviewed and updated quarterly.
- Volume rate limits per partner-recruiter to prevent spamming

### 6.7 Partner SLA & performance management

| Metric | Target |
|---|---|
| Time-to-first-submission after req opens to partner | Empanelled: 48h. Ad-hoc: not measured. |
| Submission quality rate (passed initial screen) | Empanelled: ≥40%. Below this, partner is reviewed. |
| Hire conversion rate (submitted → hired) | Empanelled: ≥3%. Below this, panel review. |
| Partner exclusivity compliance | 100% — measured by zero double-submissions across vendors |
| Partner panel review cadence | Quarterly — empanelled partners with bottom-quartile metrics flagged for renegotiation or panel removal |

**Metric definitions.** Submission quality rate = (submissions reaching screen-pass) / (total valid submissions in the measurement period); a "valid submission" is one that passed dedup and ownership checks (per §6.4). Hire conversion rate = (hires originating from this partner's submissions) / (their total valid submissions). Time-to-first-submission is measured from the moment the req is opened to the partner via `partner_assignments` to the timestamp of the first valid submission against that req. All metrics are tenant-scoped and do not aggregate across tenants.

Partners see their own metrics but not other partners'. Kyndryl admins see comparative panel view.

### 6.8 Commercial & invoice workflow

This is the link between hiring outcomes and partner payment.

| Step | Trigger | System action |
|---|---|---|
| Fee earning | Hire confirmed (Day 1 in HireOps) | Partner ownership at offer-accept date is locked. Fee record created in `partner_fees` per MSA terms (often: % of CTC × fee rate, or flat fee per grade). |
| Invoice trigger | Probation passed (typically 90 or 180 days post-hire) | Most MSAs withhold full fee until probation. Partial fee may be invoiceable on Day 1. |
| Invoice generation | Partner-initiated from portal | Partner generates invoice from completed fee record; system pre-fills amount, supporting evidence (hire date, candidate, req, MSA reference). Routes to Kyndryl AP. |
| Payment | Kyndryl AP processes | External to HireOps; status pulled back via integration with Kyndryl finance. |
| Disputes | Partner challenges a fee not credited | Manual review by Kyndryl admin with audit trail. Resolution updates fee record. |
| Clawback | Hire reverses (failed probation, retracted offer) | Fee reverses if not yet paid; clawback workflow if paid. |

### 6.9 Audit & compliance for partner activities

DPDPA implications:

- Every partner-submitted candidate record has the partner's consent attestation: "I confirm I have obtained the candidate's explicit consent to share their data with Kyndryl for recruitment purposes." Stored timestamped, retained 7 years.
- If a candidate later requests data deletion, **both** Kyndryl and the originating partner must be notified — partner is a downstream recipient under DPDPA.
- Partner data sharing is itself a "transfer to data fiduciary" event and must be logged.
- If a partner has their portal access revoked (MSA termination, breach), all access is cut immediately, but their historical submission records remain for audit + ownership/fee reconciliation.

---

## 7. Onboarding requirements (entirely missing in Lovable)

This entire section is net-new build. Lovable mentions "onboarding" once as a stage label.

### 7.1 Pre-boarding (offer-accept → Day -1)

| Capability | Required behaviour |
|---|---|
| Welcome flow | Branded welcome page, FAQ, joining-day expectations, dress code, location/remote setup. |
| Document collection | Government ID, address proof, prior employment proof, education certificates, bank details, PAN/Aadhaar for India, TIN/SSS for Philippines. Each with verification status. |
| BGV initiation | Trigger BGV vendor (HireRight / FirstAdvantage / AuthBridge for India). Receive status webhooks. Auto-update HireOps. |
| Health declaration / medical | If required by role. Vendor-fulfilled. |
| Equipment preferences | Laptop spec, peripherals, accessibility needs. |
| Day-1 orientation booking | Schedule join in HRIS, assign buddy, pre-book conference rooms. |
| Probation policy acknowledgement | DPDPA-relevant — explicit acceptance, timestamped. |
| Tax / PF / payroll forms | India: Form 11 (PF), Form F (gratuity nominee), tax declaration. Philippines: BIR 2316, SSS, PhilHealth, Pag-IBIG. **Geography-specific.** |

**Document taxonomy.** Document categories are stored in a `document_types` lookup table — `document_types(id, code, name, geography_code, required_for_lifecycle_stage, retention_years)` — which drives both UI rendering and DPDPA retention. The `geography_code` field allows India-specific documents (PAN, Aadhaar, Form 11, Form F, tax declaration) and Philippines-specific documents (BIR 2316, SSS, PhilHealth, Pag-IBIG) to be filtered per the candidate's GCC location. `onboarding_documents` rows reference `document_types` via FK so each uploaded document has a typed category and a per-category retention policy. Schema in `architecture.md` §5.1 (onboarding group).

### 7.2 Day 0 — Workday hire sync (the critical integration moment)

This is where HireOps stops being the system of record and Workday takes over for that worker.

| Capability | Required behaviour |
|---|---|
| Pre-Hire creation in Workday | **Automatically on offer-accept** (e-sign webhook → `offer_accepted` event → queued `Put_Applicant`). No recruiter or People Ops click. SOAP `Put_Applicant` or staffing equivalent. |
| Hire Employee transaction | **Automatically on Day 1** (cron-style scheduler at 00:00 IST on the candidate's first working day → queued `Hire_Employee`). No human trigger. For volume: use `Import_Hire_Employee` (parallel-safe). |
| Position assignment | Map to Workday Position created upstream during requisition approval. |
| Compensation, location, reporting line | All synced as part of Hire transaction. |
| Idempotency & reconciliation | If Workday call fails, retry per `workday-adr.md` §5.7 backoff matrix. **Daily reconciliation SLA: all Day-0 hires in HireOps must have Workday Worker IDs by Day 1 EOD (00:00 IST + 24h). Reconciliation surfaces any HireOps↔Workday divergence (worker active in one, terminated in the other; positions out of sync; etc.) within 24h of the discrepancy occurring. More than 5 divergences in any rolling 7-day window triggers a P2 PagerDuty alert and runbook activation per `workday-adr.md` §6.3.** |
| Worker ID write-back | Workday Worker ID written back to HireOps employee record. Permanent linkage. |

### 7.3 Day 1 to Day 30

| Capability | Required behaviour |
|---|---|
| IT provisioning queue | Hand-off to IT persona. Laptop, email account, AD/Okta, Slack/Teams, role-based app access (Jira, Confluence, GitHub, AWS, etc.). Each step tracked. |
| Access provisioning via SCIM | Where possible, automate via SCIM to Okta/Azure AD/Google Workspace, which downstream provisions to apps. |
| Buddy / manager assignment confirmation | Manager confirms buddy paired, first 1:1 scheduled. |
| Training assignment | Mandatory compliance training (POSH for India, harassment training for PH/US, security awareness, code of conduct). LMS integration or built-in. |
| 7-day, 14-day, 30-day check-ins | Auto-scheduled with manager + People Ops. Pulse survey at 30 days. |
| Probation tracking | Default 90 days, configurable up to 180 days per role/grade. Per-tenant override supported via admin → workflows → onboarding. Probation review milestone fires at the configured day. |

### 7.4 Onboarding analytics

| Capability | Required behaviour |
|---|---|
| Time-to-productivity dashboard | Days from Day 1 to first commit / first ticket / first deliverable. Role-dependent. |
| 30/60/90 retention | Early-attrition tracking. Fundamental KPI. |
| Onboarding NPS | Pulse survey, trended. |
| Funnel: offer accepted → Day 1 → Day 30 cleared | Where do new hires drop out? Pre-joining ghosting is a known GCC problem. |

---

## 8. Offboarding requirements (entirely missing in Lovable)

### 8.1 Initiation

| Capability | Required behaviour |
|---|---|
| Resignation submission | Employee self-service in portal — last working day, reason (drop-down + free text), manager notified. |
| Termination initiation (HR-side) | HR-led for performance / restructure / misconduct. Different workflow, more sensitive, more approvals. |
| Notice period management | Calculate based on grade + contract. India: typically 30/60/90 days **(notice period — distinct from probation period in §6.8 which can also be 90/180 days; these are independent clocks)**. Approve early release, garden leave, buy-out. |
| Manager acknowledgement | Manager confirms within 48h. Triggers downstream. |

### 8.2 Notice period

| Capability | Required behaviour |
|---|---|
| Knowledge transfer plan | Templated KT checklist by role family. Manager + employee confirm completion. |
| Asset return checklist | Laptop, peripherals, ID card, books, devices. Each tracked, signed-off by IT. |
| Pending leave / comp-off settlement | Pull from Workday absence module. Calculate encashment. |
| Outstanding loans / advances | Flag from finance for clearance. |
| Final settlement (F&F) calculation | Salary + leave encashment + bonus pro-rata − loans − notice-shortfall. |

### 8.3 Last working day & Day +1

| Capability | Required behaviour |
|---|---|
| Access revocation | Trigger SCIM-driven revoke across all apps. Email auto-reply set. Slack/Teams deactivated. AD account disabled. |
| Hardware return confirmation | IT confirms before final settlement is released. |
| Workday Terminate | SOAP `Terminate_Employee`. Workday becomes source-of-truth for the now-former-worker. |
| Exit interview | Online questionnaire + optional 1:1 with HR. Themes captured, anonymisable for analytics. |
| Re-hire eligibility flag | Decision recorded: yes / no / with-restrictions. |
| Alumni status | Employee record archived; alumni record created with retention horizon per DPDPA. |

### 8.4 Offboarding analytics

| Capability | Required behaviour |
|---|---|
| Attrition by reason / cohort / function | Trended monthly. |
| Regrettable vs non-regrettable attrition | Manager-tagged. |
| Exit-interview theme analysis | LLM clusters free-text by theme (compensation, manager, growth, role fit, etc.). |
| Tenure cohort survival curves | "How long do hires from cohort X stay?" |

---

## 9. Cross-cutting requirements

### 9.1 Workday integration — what HireOps must support

This is detailed in `architecture.md` but the requirements are:

| Sync | Direction | Trigger | Frequency / mode |
|---|---|---|---|
| Org structure (departments, cost centers, locations) | WD → HireOps | Daily snapshot | Batch, nightly |
| Positions | WD → HireOps | On position create/update in WD | 15-min poll (Workday does not natively support outbound webhooks; see `workday-adr.md` §1). |
| Headcount approvals | HireOps → WD | New requisition approved | Real-time (REST) |
| Hire (Pre-Hire + Hire) | HireOps → WD | Offer accepted → Day 1 | Real-time (SOAP `Hire_Employee` or `Import_Hire_Employee` for batch) |
| Worker updates (post-hire data corrections) | Bidirectional | On change | Real-time |
| Termination | HireOps → WD | Last working day confirmed | Real-time (SOAP `Terminate_Employee`) |
| Worker record reads | WD → HireOps | On demand | REST + WQL |

Every sync is **idempotent**, **logged**, **retriable**, and **reconcilable**. The Lovable `integrations` table has none of this.

### 9.2 Compliance — non-negotiable for Kyndryl

| Requirement | Detail |
|---|---|
| **DPDPA 2023 (India), effective from Nov 2025** | Consent management, data principal rights (access / correction / erasure / portability), breach notification within 72h, retention schedules per data category, DPO appointment if classed as Significant Data Fiduciary (likely for Kyndryl). |
| **Rejected-candidate erasure** | Auto-purge after retention period (default 6 months unless candidate consents to talent pool). |
| **Consent records** | Retain consent audit for 7 years per DPDPA Rule 4. |
| **Data residency** | India data may need to stay in Indian data centres (DPDPA does not currently require it but Kyndryl policy may). Architectural implication: Supabase region = ap-south-1 / Mumbai. |
| **Audit log** | Every PII access logged: who, what, when, why. 7-year retention. |
| **Bias / fairness reports** | Quarterly: selection rate by gender, age band, region. **Threshold: selection rate ratio between any two protected groups must stay above 0.8 per the EEOC 4/5ths rule.** Deviations below 0.8 in any cohort are flagged in the report and trigger a human review of the relevant pipeline stages. EEOC analogue if Kyndryl-US is in scope. Reports are consumed by HR Director and tenant compliance owner. |
| **PoSH compliance training** | Mandatory in India onboarding flow. |
| **GDPR** | If any Kyndryl entity touches EU candidates. |
| **SOC 2** | Kyndryl will ask. POC need not have it; production roadmap must. |
| **ISO 27001** | Same — Kyndryl will ask. |

### 9.3 Security model

| Requirement | Detail |
|---|---|
| SSO via SAML or OIDC | Mandatory for internal users. Likely Okta or Azure AD. Lovable's email/password is unacceptable. |
| MFA | Mandatory for internal. Optional for candidates but encouraged. |
| Role-based access (RBAC) | Already partially in Lovable schema (`user_roles`, `has_role()`). Extend for new personas. |
| Attribute-based access (ABAC) | Recruiter A can only see candidates for reqs assigned to them. Manager X only sees their own org's hires. Schema ready, policies need refinement. |
| Row-level security | Lovable has good RLS coverage. Audit and harden. |
| Field-level encryption | PAN / Aadhaar / SSN-equivalents must be encrypted at rest beyond Postgres TDE. |
| API rate limiting | Both internal and candidate-facing. |
| Penetration test | Before production. Annual after. |
| Demo bypass | Lovable's `enterDemo()` cannot exist in production. Flag-gated and removed from prod build. |

### 9.4 Observability

Entirely absent in Lovable.

- Application logs (Datadog / Grafana Cloud / Better Stack)
- Error tracking (Sentry)
- Product analytics (PostHog / Mixpanel) — funnel from apply → hire is a board-level metric
- Performance monitoring (Lighthouse-style budgets, Core Web Vitals)
- Uptime monitoring (UptimeRobot / Pingdom)
- Audit logs piped to SIEM if Kyndryl wants

### 9.5 Notifications

Lovable has email (SMTP) and WhatsApp scaffolding. Required:

- Email — transactional (offer letters, interview confirmations, status updates)
- WhatsApp Business — IN/PH candidates expect this
- SMS fallback
- Push (mobile) — for recruiters on the move
- In-app — bell/notification dropdown
- Slack/Teams — for internal handoff (recruiter → HM → People Ops)

Each channel must have: opt-in, opt-out, throttling, audit, template versioning, multi-language.

**Default notification matrix (per persona × event-type).** Each tenant can override these defaults via admin → workflows → notifications.

| Persona | Critical events | Routine updates | Digest cadence |
|---|---|---|---|
| Recruiter | In-app + email (real-time) for partner-submitted candidates and high-AI-score applicants | In-app for stage transitions; daily email digest for pipeline summary | Daily 09:00 IST |
| Hiring manager | Email (real-time) for "needs your review" + Slack/Teams if integrated | Email digest for pipeline status on their reqs | Daily 08:30 IST |
| Interview panel | Email + calendar invite for upcoming interviews; in-app reminder 24h before; SMS if feedback overdue | None | Weekly summary of upcoming interviews |
| HR Operations | In-app + email for offer-related events; SLA-breach alerts in real-time | In-app for routine case updates | Daily 09:00 IST |
| People Ops | In-app + email for onboarding case state changes; real-time for BGV failures and Workday Hire failures | In-app for routine case updates | Daily 08:00 IST |
| IT / Workplace Services | In-app + email for new provisioning request; SLA breach in real-time | In-app for completed handoffs | Daily 08:00 IST |
| Hiring Approver Chain | Email (real-time) with deep-link to approval UI; mobile-optimised | None | None — approvals are event-driven |
| Candidate | Email (real-time) for stage transitions, interview invites, offer; WhatsApp same events if opted-in | None | None — candidate experience is event-driven |
| HR Partner (recruiter) | In-app + email for stage changes on own candidates; real-time for offer/hire of own candidate | None | Daily 09:00 IST |
| HR Partner (org admin) | Email (real-time) for hire confirmations and fee-eligible events | Weekly commercials summary email | Weekly Monday |
| TA Lead / HR Director | Email digest for pipeline health, SLA breaches, partner quality dips | Quarterly DPDPA fairness report email | Daily TA Lead, Weekly HR Director |
| Tenant admin | In-app + email for integration failures, tenant-config changes | None | Weekly admin summary |

Notification volume is itself a metric — tenant admins see "notifications sent per persona per day" in admin → workflows → notifications, with the option to throttle if recruiters report notification fatigue. The platform default is calibrated to keep recruiters under ~30 notifications/day at 300/month volume.

### 9.6 Bulk operations (Lovable does not support this)

At 300/month a recruiter doing one-by-one operations cannot keep up. Required:

- Bulk move (50 candidates → next stage)
- Bulk reject (with templated rejection reasons + automated email)
- Bulk message (with personalisation tokens)
- Bulk schedule (slot-pool offered to N candidates, first-come-first-served)
- Bulk export to CSV
- Bulk import (CSV upload of candidate list from agency)

**Performance budget for bulk operations.** Up to 50 records per operation (Wave 2 ships single-batch limits per `requirements.md` §11). State-transition operations (move, reject) must complete with P95 < 5s end-to-end. Bulk message dispatch — including template rendering, channel routing, and queueing — P95 < 30s for 50 recipients. Bulk export (CSV) P95 < 10s for 50 records. Operations exceeding these budgets degrade gracefully: progress is shown, individual failures are surfaced inline, partial completion is acceptable. The platform never silently fails bulk operations.

### 9.7 Search

Lovable has a search bar in the header but it is decorative. At Kyndryl volume:

- Full-text search across candidates (name, skills, experience, resume content)
- Faceted filtering (stage, location, skill, score band, requisition, source)
- Saved searches
- Resume content search (PDF/DOCX content indexed)
- Boolean search for sourcing ("React AND (TypeScript OR JavaScript) AND NOT manager")

Probably needs Postgres full-text + tsvector for v1; Elasticsearch / OpenSearch for v2.

### 9.8 Reporting

Lovable has dashboards. They are pretty. They are static. Required:

- Time-to-fill / time-to-hire by req, function, location
- Cost-per-hire (offer accepted / cost of recruiter time + agency fees + posting costs)
- Source-of-hire effectiveness
- Funnel conversion at every stage
- Recruiter productivity (hires-per-recruiter, candidates-touched, SLA breaches)
- Panel productivity & feedback turnaround
- Offer acceptance rate
- 30/60/90 attrition
- Diversity metrics (with privacy controls)
- Custom report builder (Phase 2)
- Scheduled email reports

### 9.9 Internationalisation

Lovable has `LanguageContext` but no translations. For Kyndryl GCC POC: English only is acceptable. For production: at minimum candidate portal must support Hindi (India), Tagalog (PH), and Spanish (if LATAM in scope).

### 9.10 Mobile

Lovable is responsive-ish but desktop-first. Recruiters at agencies / panellists between meetings / candidates anywhere — **mobile is critical for candidate and panel personas**. Recruiter can stay desktop-first. Native app is not needed for POC; PWA-quality responsive web is.

---

## 10. Feature audit of Lovable's 78 pages

This is the page-by-page disposition. **K = Keep, M = Modify, D = Drop, MISS = Missing concept that needs to be added.** For brevity, "Modify" implies the page concept is right but the implementation must be rebuilt against real data.

### 10.1 Recruiter persona (8 pages)

| Page | Disposition | Note |
|---|---|---|
| RecruiterDashboard | M | KPI tiles correct. Replace mock data with React Query hooks. Add SLA breach widget. |
| RecruiterCandidates | M | Add bulk operations, faceted filters, server-side pagination (300/month → thousands of records). |
| RecruiterShortlist | M | Same as above; AI shortlist needs real scoring backend. |
| RecruiterMissingInfo | M | Useful concept for data hygiene. Wire to real candidate fields. |
| RecruiterNewRequisition | M | Fold into req creation flow shared with HM. |
| RecruiterAnalytics | M | Real metrics, not mocks. |
| RecruiterCandidateDetail | M | Largest page (417 lines) — break into tabs (Profile / Applications / Interviews / Communications / Audit). |
| InterviewRoom | D for build, M to integrate Zoom/Teams | Building WebRTC is out of POC scope. |

### 10.2 Requirement Owner / Hiring Manager (11 pages)

| Page | Disposition | Note |
|---|---|---|
| OwnerDashboard | M | Open reqs, candidates needing my review, upcoming interviews I'm panel for. |
| OwnerRequisitions | M | List view of my reqs. |
| CreateRequisition | M | 628 lines — the largest page. Refactor into a multi-step wizard with proper validation, draft saving, position-from-Workday lookup. |
| OwnerJDBuilder | K | Solid. Just needs real LLM backend. |
| OwnerJDLibrary | K | Useful. |
| OwnerSkillWeights | K | Good — feeds AI scoring. |
| OwnerPanelSetup | M | Pull panel pool from real org data, not mock. |
| OwnerApprovalTracker | M | Show real approval status. |
| OwnerInsights | D for POC | Predictive insights are nice-to-have; not POC-critical. |
| OwnerRequisitionDetail | M | Tabbed: candidates, interviews, approvals, comments. |
| OwnerCandidateAssessment | M | Where HM reviews candidates and gives go/no-go. |

### 10.3 HR Head (9 pages)

Reframe: split between "TA Lead" and "HR Director" view toggles.

| Page | Disposition | Note |
|---|---|---|
| HRHeadDashboard | M | TA Lead operational view by default. |
| HRHeadApprovals | M | Multi-level approval inbox. |
| HRHeadFeasibility | D for POC | "Can we hire this many in this timeframe" — predictive, nice-to-have. |
| HRHeadMarketIntelligence | D for POC | Same. |
| HRHeadAnalytics | M | Core analytics — required, must be real. |
| HRHeadCostPerHire | M | Required metric. |
| HRHeadPipeline | M | Cross-recruiter pipeline view. |
| HRHeadGovernance | M | Policy library, approval matrix config. |
| HRHeadAudit | M | Critical for DPDPA. |

### 10.4 HR Team / HR Operations (8 pages)

Persona scope expands to include onboarding/offboarding kickoff.

| Page | Disposition | Note |
|---|---|---|
| HRTeamCases | M | Useful "case management" concept; extend to onboarding/offboarding cases. |
| HRTeamCaseDetail | M | Same. |
| HRTeamHRRounds | M | HR final round scheduling. |
| HRTeamOffers | M | Offer drafting + approval. |
| HRTeamDocuments | M | Document collection — extend to BGV docs, joining docs. |
| HRTeamAnalytics | M | Real metrics. |
| HRTeamTemplates | K | Templates for emails, offers, KT plans, exit letters. Useful. |
| HRTeamAudit | M | Audit trail of HR-side actions. |

### 10.5 Panel (8 pages)

| Page | Disposition | Note |
|---|---|---|
| PanelDashboard | M | My upcoming interviews, pending feedback. |
| PanelInterviews | M | List view. |
| PanelMonitor | D for POC | "Monitor in-progress interviews" — niche. |
| PanelCandidateBrief | K | AI-generated candidate brief is genuinely useful for time-poor panels. |
| PanelInterviewRoom | M | Integrate Zoom/Teams. |
| PanelScorecard | K | Solid concept. Wire to real config. |
| PanelFeedbackList | M | Pending feedback inbox with SLA timer. |
| PanelHistory | K | "Interviews I've done" history. |

### 10.6 Candidate (9 pages)

| Page | Disposition | Note |
|---|---|---|
| CandidateDashboard | M | "My applications, my interviews, what's next." |
| CandidateProfilePage | M | Profile editor with DPDPA consent panel (currently absent). |
| CandidateApplications | M | Application tracker — keep concept, real backend. |
| CandidateInterviewsPage | M | Self-service slot picking, joining link. |
| CandidateDocuments | M | Document upload + status. Extend for joining docs. |
| CandidateInterviewRoom | M | Zoom/Teams integration. |
| CandidateAICoach | D for POC | 523 lines of AI coach — nice-to-have, expensive in tokens, not POC-critical. |
| CandidateNotifications | M | In-app notification feed. |
| CandidateSettingsPage | M | DPDPA controls: data download, deletion request, consent withdrawal, language. |

### 10.7 Admin (11 pages)

| Page | Disposition | Note |
|---|---|---|
| AdminDashboard | M | Real ops view: integration health, error rates, user activity. |
| AdminGlobalSettings | K | |
| AdminUsersRoles | M | SSO-aware user management. |
| AdminAISettings | M | Prompt management, model selection, usage budgets. |
| AdminBiasShield | K | Configure fairness thresholds. |
| AdminIntegrations | M | Replace mock integrations list with real connectors (Workday, Okta, Zoom, BGV vendor, job boards, LMS). |
| AdminWorkflows | M | Workflow engine config — must be real, drives onboarding/offboarding flows. |
| AdminThemeBranding | K | White-labelling — nice for Kyndryl (their colours). |
| AdminAudit | M | Required for DPDPA. |
| AdminMessaging | M | Notification template management. |
| AdminSystemSetup | M | Org config: locations, departments, role grades, approval matrix. |

### 10.8 Shared / utility (14 pages)

Login, signup, OTP verify, reset password, forbidden, 404, landing — all keep with hardening (SSO replaces email/password for internal users, DPDPA consent on signup, etc.).

### 10.9 Pages / capabilities to add that Lovable does not have

| Capability | Persona | Priority |
|---|---|---|
| Career site (public-facing) | Candidate (anonymous) | P0 |
| Job-board posting console | Recruiter | P0 |
| Bulk operations | Recruiter, HR Ops | P0 |
| **Partner portal — login + dashboard** | **HR Partner (new)** | **P0** |
| **Partner portal — open reqs & submission** | **HR Partner** | **P0** |
| **Partner portal — pipeline tracking (own candidates only)** | **HR Partner** | **P0** |
| **Partner portal — speculative talent pool submission** | **HR Partner** | **P0** |
| **Partner portal — commercials & invoice dashboard** | **HR Partner admin** | **P0** |
| **Partner portal — candidate communication (logged + monitored)** | **HR Partner** | **P0** |
| **Partner admin: panel management (Kyndryl side)** | **Admin / TA Lead** | **P0** |
| **Partner admin: ownership dispute resolution** | **Admin** | **P0** |
| **Email-intake parser for ad-hoc partners** | **System (no UI)** | **P0** |
| Onboarding case board | People Ops (new) | P0 |
| Onboarding journey (per-hire view) | People Ops + Employee | P0 |
| BGV vendor sync UI | People Ops | P0 |
| IT provisioning queue | IT (new) | P0 |
| Asset register | IT | P0 |
| Workday integration health & reconciliation | Admin | P0 |
| Offboarding initiation (employee self-service) | Employee | P0 |
| Offboarding case board | HR Ops | P0 |
| Knowledge transfer tracker | Employee + manager | P0 |
| F&F settlement console | HR Ops + Finance | P0 |
| Exit interview & analytics | HR Ops | P1 |
| **Partner SLA & quality dashboards (cross-partner comparative)** | **TA Lead** | **P1** |
| Talent pool / silver-medallist | Recruiter | P2 |
| Referral programme | All employees | P2 |
| Alumni portal | Ex-employees | P2 |

---

## 11. POC scope decision

The user asked for an honest scope recommendation. Given:

- Full lifecycle (recruitment + onboarding + offboarding)
- 300 hires/month from day one of go-live
- Workday integration as HRIS-of-record
- HR Partner sourcing as the dominant candidate channel (50–70% of flow)
- Realistic team size (8–12 engineers + 2 designers + PM + Workday integration specialist + DevOps + QA)

**My honest recommendation: 24-week POC, three waves.** (Up from 22 weeks because partner portal is now in Wave 1 — partner sourcing is too big a part of the candidate flow to defer.)

### Wave 1 — "End-to-end thin slice" (weeks 1–11)
Goal: process one hire end-to-end through every lifecycle stage, with the partner sourcing channel functional. Volume: 10 hires across the wave, of which 6 should arrive via partner submission. Real data, real Workday, real BGV vendor, real partners (start with 3 friendly empanelled vendors).

- Foundations: repo cleanup, CI/CD, observability, auth (SSO + partner auth tier), design system
- Recruitment core: req → JD → posting → apply → screen → interview → offer accept (no bulk ops yet, no AI scoring beyond MVP)
- **Partner portal core: login, dashboard, view-open-reqs, single-candidate submission, pipeline tracking for own candidates**
- **Candidate ownership state machine + dedup (this is non-negotiable infrastructure even at low volume — the rules can't be retrofitted later)**
- **Email-intake parser for ad-hoc partners (basic CV extract + attribution)**
- Workday integration: read org structure + positions, write Pre-Hire + Hire
- Onboarding minimal: BGV trigger, document collection, IT provisioning queue, Day 1 checklist
- Offboarding minimal: resignation flow, asset return, Workday Terminate
- Candidate portal: apply, track, attend interview, accept offer, complete onboarding

### Wave 2 — "Volume & polish" (weeks 12–18)
Goal: handle 50 hires/month for 1 month as a stress test, with 10–15 active partners.

- Bulk operations across recruiter & HR Ops
- **Partner portal: bulk submission, speculative talent pool, communication module with content scanner**
- **Partner commercials & invoice dashboard (read-only; full invoice integration is Wave 3)**
- **Partner SLA dashboards & comparative panel view for Kyndryl admin**
- AI scoring + bias shield (real)
- WhatsApp / SMS notifications (real)
- Resume parsing (better quality, multi-format)
- Job-board posting (LinkedIn + Naukri at minimum)
- Onboarding analytics dashboard
- Reporting suite (time-to-fill, cost-per-hire, funnel, partner-effectiveness)
- Performance hardening (database indexes, caching, query optimisation)

### Wave 3 — "Production readiness" (weeks 19–24)
Goal: 300 hires/month sustained for 1 month before declaring POC successful, with a working partner panel of 10–15 active empanelled vendors plus an open ad-hoc registration flow. The full panel of 20–30 empanelled vendors ramps over Q2 post-POC; this is intentional — onboarding more than 15 partners in 6 weeks creates panel-management overhead that distorts the POC's quality signal.

- Pen test + remediation (with explicit partner-portal threat modelling)
- DPDPA compliance audit (partner consent attestation flow critical)
- DR / backup tested
- Runbook + on-call rotation
- Workday reconciliation jobs hardened
- **Partner ownership dispute resolution UI**
- **Partner invoice integration with Kyndryl finance / AP**
- Final UAT with Kyndryl GCC team + 5 partner organisations
- Training material for recruiters + HMs + panellists + partner admins

### What does NOT make the 24-week POC

- AI Coach (CandidateAICoach)
- HR Head Market Intelligence / Feasibility (predictive)
- Owner Insights (predictive)
- Internal-employee talent pool / silver-medallist re-engagement
- Referral programme
- Alumni portal
- Custom report builder
- Multi-language UI
- Mobile-native apps
- Partner-side analytics beyond their own metrics (no marketplace-style features)
- Automated fee calculation per MSA terms (Wave 3 ships manual override; full automation Phase 2)

These go into the post-POC roadmap if Kyndryl converts.

### Why not 12–16 weeks

Three reasons:
1. **Workday integration alone is 4–6 weeks of careful work** (ISU setup, SOAP wrapper, idempotency, reconciliation, sandbox testing with Kyndryl's tenant). Cannot be parallelised against everything else.
2. **DPDPA compliance is not a checkbox** — consent flows, retention rules, audit trails, DPO workflows must be designed in, not bolted on.
3. **300/month means real concurrency** — every "it works for one user" demo breaks at 50. Performance work is non-trivial and cannot be deferred without breaking the POC at the moment Kyndryl is judging it.
4. **Partner portal is non-trivial.** Two-tier auth (separate from Kyndryl SSO), candidate ownership state machine with dedup, content-scanned communication, commercials tracking, dispute resolution. The state machine in particular cannot be retrofitted — it has to live at the database/policy layer from day one or partners will dispute fees retroactively.

12–16 weeks is feasible **only** for "recruitment up to offer accepted, no Workday, no onboarding, no offboarding, no partner portal" — which is not what Kyndryl asked for. With the partner channel being 50–70% of expected flow, a POC without it is not a POC; it's a demo.

---

## 12. POC-onboarding configuration items

The following are POC-onboarding configuration items. As the platform vendor we have made defensible defaults for each; Kyndryl confirms or configures differently as part of their tenant onboarding flow. **None of these block product development** — they all map to features we ship that are tenant-configurable.

### Q1 — GCC location

- **Default:** India (Bangalore, Pune). Drives DPDPA compliance posture, data-residency selection, holiday calendars, language, payroll integration partner.
- **Configuration surface:** tenant settings → primary region (drives downstream defaults — document_types geography_code, calendar locale, etc.).
- **POC onboarding:** confirmed during initial tenant provisioning. Platform supports any region; only the connected integrations (BGV vendor, payroll forms) shift per region.

### Q2 — Workday tenant access

- **Default:** customer provides ISU + OAuth credentials in admin → integrations → Workday. Encrypted credentials stored in Vault per `architecture.md` §6.3.
- **Configuration surface:** per-tenant Workday connection settings (`integration_credentials` row scoped by tenant).
- **POC onboarding:** Kyndryl HRIS Lead provisions sandbox tenant + ISU + Integration System Security Group + OAuth client in week 1 of POC; production credentials provisioned at cutover. Provisioning steps in `workday-adr.md` §5.3 + §6.1.

### Q4 — SSO provider

- **Default:** platform supports both Okta and Azure AD via SAML/OIDC, plus any OIDC-compliant IdP. Audience-scoped JWTs per portal per `architecture.md` §7.2.
- **Configuration surface:** tenant settings → identity → SSO. SCIM provisioning configured separately when the IdP supports it.
- **POC onboarding:** Kyndryl provides OIDC discovery URL or SAML metadata during onboarding; SCIM provisioning configured optionally for downstream app provisioning (`requirements.md` §7.3).

### Q5 — BGV vendor

- **Default:** AuthBridge (India-strong, fast turnaround) is the platform's first-party integration. HireRight and FirstAdvantage are also supported as first-party integrations. Selection per tenant.
- **Configuration surface:** tenant settings → integrations → BGV vendor. Per-tenant credentials in Vault; webhook secrets per environment per vendor per `architecture.md` §8.1.
- **POC onboarding:** Kyndryl picks from the platform's supported list during onboarding. Switching vendors later is a config change, not code.

### Q8 — Approval matrix

- **Default:** platform ships a configurable approval-matrix engine (grade × cost × org-level rules). Pre-loaded templates for common patterns. Maps to `approval_chains` / `approval_requests` / `approval_decisions` per `architecture.md` §5.1.
- **Configuration surface:** admin → workflows → approvals. Per-tenant configuration; no platform changes required for new chains.
- **POC onboarding:** Kyndryl HR Director defines their approval matrix during onboarding using the configurator. Matrix can evolve over time without code change.

### Q15 — Partner panel composition

- **Default:** platform supports onboarding any number of empanelled partners + ad-hoc registrations. No platform-side constraint on panel size.
- **Configuration surface:** admin → partners → invite (empanelled flow per `partner-wireflows.md` §5.1) and admin → partners → register-ad-hoc (sender-domain registration).
- **POC onboarding:** Kyndryl's TA Lead invites their existing 3-5 friendly partners during onboarding; ad-hoc partners self-register-by-domain as they show up.

### Q16 — Partner MSA template

- **Default:** platform ships a configurable commercial-terms engine (fee structure, exclusivity windows, holdback, replacement guarantees, dispute rules). Standard MSA archetypes pre-loaded. Schema per `architecture.md` §7.8 + `/docs/partner-data-model.md`.
- **Configuration surface:** admin → partners → commercial templates. Per-partner overrides supported via `partner_msa` rows.
- **POC onboarding:** Kyndryl's procurement uploads their standard MSA, the configurator captures the salient terms (fee structure, exclusivity scope, holdback, replacement mode); per-partner MSA overrides supported.

### Q18 — Partner panel governance owner

- **Default:** platform supports both unified ("TA Lead owns partners end-to-end") and split ("Procurement owns commercials, TA Lead owns operations") org models via role permissions.
- **Configuration surface:** admin → users → roles. Permission grants on `partner_msa`, `partner_fees`, `partner_invitations` etc. are scoped to roles, not job titles.
- **POC onboarding:** Kyndryl decides during onboarding; role permissions configured accordingly. Switching models later is a config change.

### Other items (Wave 2 or already resolved)

These remain in the table but are not Wave 1 POC-onboarding blockers. Listed for completeness.

3. **Kyndryl careers site?** Is HireOps-hosted careers page sufficient, or must apply originate on `careers.kyndryl.com`? — Default per `open-questions.md` §c: HireOps-hosted careers site for POC; if `careers.kyndryl.com` must front, CRS-02 doubles in scope.
6. **Job-board contracts?** LinkedIn Recruiter seats? Naukri RMS account? Kyndryl-existing? — Wave 2 (job-board posting deferred per §11).
7. **IT provisioning systems?** What downstream — Okta SCIM? ServiceNow? Internal ticketing? — Default: SCIM target follows Q4 SSO decision; manual stub for any apps without SCIM.
9. **Compensation bands & grade structure?** Required to drive comp recommendations. — Wave 2 for full comp engine.
10. **Production data residency requirement?** ap-south-1 (Mumbai) vs us-east-1 vs EU? — Non-blocking for POC; production roadmap. Per-tenant data residency is acknowledged in the Multi-Tenancy ADR (forthcoming).
11. **SOC 2 / ISO 27001 timeline?** POC tolerance vs production blocker. — POC tolerated; production roadmap.
12. **Branding?** Kyndryl logo / colours / "powered by HireOps" positioning? — Default: white-label per tenant (admin → branding); Wave 2 polish.
13. **Volume ramp?** 300/month from week 1 of go-live, or ramp from 50 → 150 → 300 over Q1? — Production rollout question, not Wave 1 build.
14. **Languages?** English-only acceptable? Hindi / Tagalog needed for candidate portal? — **RESOLVED:** English only for POC (per §9.9); Hindi / Tagalog deferred to production roadmap.
17. **Existing partner data?** Are there candidates already in flight via partners that need to be migrated in with ownership preserved? — Non-blocking; migration is a separate workstream.
19. **Invoicing & finance integration?** Does Kyndryl AP have an existing system we should integrate with for partner invoicing (SAP, Oracle, Coupa)? Or do partners invoice through email/PDF? — Wave 3.
20. **Ad-hoc partner email aliases?** Will Kyndryl provision per-partner email addresses (`partner-acme-cvs@kyndryl-hireops.com`) or do we need a different attribution mechanism? — **RESOLVED:** per-req aliases (`cvs-{req-id}@kyndryl-hireops.com`) plus `cvs-talent-pool@kyndryl-hireops.com`; partner attribution comes from sender-domain lookup against `ad_hoc_partners` (per §6.5).

### Closing note

Each of the items above is a tenant-onboarding flow, documented in the (forthcoming) Multi-Tenancy ADR. None block platform development. They are surfaced here only as the POC onboarding checklist for Kyndryl.

---

## 13. What this document is not

- It is not the architecture. That is in `architecture.md`.
- It is not the design system. That is a separate spec to follow, after Wave 1 stabilises core flows.
- It is not the project plan. That comes after Kyndryl signs off on scope.
- It is not final. Every requirement in here will move once Kyndryl shares their actual operating model. Treat this as a strong v0.1.
