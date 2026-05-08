# HireOps — Product Requirements

**Version:** 0.1 (POC scoping draft)
**Date:** 8 May 2026
**Audience:** Internal product + engineering, Kyndryl GCC stakeholders
**Context:** Kyndryl GCC POC — 300 hires/month for 12 months (3,600 hires/year), full lifecycle (recruitment + onboarding + offboarding), HireOps as ATS, Workday as HRIS-of-record. **Sourcing model: ~60% via HR partners (mix of empanelled vendors and ad-hoc agencies), ~40% direct/referrals.** Partner portal is a first-class capability of the platform.

---

## 1. How to read this document

The Lovable codebase has 78 pages across 7 personas. Most of them describe a recognisable enterprise ATS, but they were generated to demonstrate ideas — not to operate at the volume Kyndryl needs. This document does three things:

1. **Re-frames the product around real workflows**, not Lovable's screen taxonomy. A page is not a feature; a feature is something that produces a measurable outcome (a hire, an offer accepted, a candidate informed, a Workday worker created).
2. **Goes through every Lovable feature** and marks it Keep / Modify / Drop / Missing, with reasoning grounded in the 300/month workload.
3. **Flags everything Lovable never covered** — sourcing channels, BGV, compliance, IT provisioning, asset management, exit workflows, observability, bulk operations, etc.

Where Kyndryl-specific context matters (volume, geography, Workday, GCC-specific compliance) it is called out inline.

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

**Final persona count: 12.** This is significantly more than Lovable's 7 but it is honest about the actual operating reality of a GCC at this scale. The HR Partner persona alone may carry more daily user load than any internal persona — at 60% of 9,000 monthly applications, that's ~5,500 partner-side submissions/month spread across 20-30 partner organisations.

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
┌──────────────────── ONBOARDING ─────────────────────┐
│                                                      │
│  Pre-board     BGV         Document      Workday    │
│  Initiated  →  Cleared  →  Collected  →  Hire Sync  │
│                                                      │
│  IT            Day 1       30-Day       Probation   │
│  Provisioned → Welcome  →  Check-in  →  Confirmed   │
│                                                      │
│  → ACTIVE EMPLOYEE                                   │
│  → Partner fee invoice eligible (post-probation)    │
└──────────────────────────────────────────────────────┘
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
| Resume parsing | ❌ Missing | LLM-based parser → structured candidate record. Support PDF, DOCX, image-based scans (OCR). | **Missing — critical.** |
| Email-to-apply (forward resumes to a mailbox) | ❌ Missing | Common in IN/PH GCC sourcing — agency partners email resumes. | **Missing — required.** |
| Referral programme | ❌ Missing | Internal referral submission, tracking, payout workflow. Often 30–40% of GCC hires. | **Missing — Phase 2.** |
| Agency / HR partner portal | ❌ Missing | Empanelled partners submit CVs against reqs, track pipeline, see commercials. **See Section 6 for full requirements** — this is now treated as a first-class capability and Wave 1 in-scope rather than a Phase 2 nice-to-have. | **Missing — P0 for POC.** |
| Talent pool / silver-medallist recontact | ❌ Missing | DPDPA-relevant: requires explicit consent. Rejected-but-strong candidates re-engaged for future roles. | **Missing — Phase 2.** |
| Candidate dedup | ❌ Missing | Same person applies via 3 channels — must be merged. Email + phone + name fuzzy match. | **Missing — critical.** |
| WhatsApp / SMS apply | ✅ Partial (WhatsApp infra) | Lovable has WhatsApp infrastructure but no apply flow built. Worth completing — IN/PH candidates respond to WhatsApp at 4–10x email rates. | **Modify.** |

### 5.4 Screening & shortlisting

| Capability | Lovable status | Required behaviour | Disposition |
|---|---|---|---|
| AI candidate scoring | ✅ Present (mocked) | Real implementation: weighted skill match against JD, resume-vs-JD semantic match, experience alignment. Score ∈ [0, 100]. | **Keep, build for real.** |
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
| Comp recommendation | ✅ Present (mocked) | Real: market data + internal equity check + budget envelope check. | **Modify.** |
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

**Core rule:** First valid submission wins, with a 90-day exclusivity window per candidate, scoped to the req they were submitted against.

#### What "valid submission" means

A submission is valid only if **all** the following hold:

1. CV uploaded with parseable contact details (name, phone, email)
2. DPDPA consent attestation present and accepted
3. Candidate not already in HireOps via any other route (Kyndryl-direct, another partner, or earlier-in-window submission from same partner)
4. Submitted against an open req that the partner is empanelled for, OR submitted to the speculative talent pool with skill tags

Submissions that fail any of these are rejected with a clear reason code. They do not count for ownership.

#### What ownership grants

If Partner A's submission of Candidate X against Req R is the first valid submission:

- **Partner A owns Candidate X for Req R for 90 days from submission date.**
- If Candidate X is hired into Req R during the 90-day window — by **any** path (partner submission, direct application, recruiter outreach, referral) — Partner A is entitled to the placement fee per their MSA.
- If Candidate X is hired into a **different req** at Kyndryl during the 90-day window, default rule: Partner A's fee applies, **unless** their MSA explicitly limits exclusivity to the originally-submitted req.
- If Candidate X is rejected for Req R but is still active at Kyndryl elsewhere within the window, ownership stays with Partner A.

#### When ownership lapses

- 90 days from submission with no hire: lapses. Candidate becomes fair game for re-submission by any partner or for direct sourcing without fee attribution to Partner A.
- Candidate explicitly opts out: lapses (DPDPA right). No fee.
- Partner withdraws the candidate or breaches MSA: lapses, with audit trail.

#### Edge cases — coded as data rules, not human judgement

| Scenario | Resolution |
|---|---|
| Two partners submit same candidate within seconds | Database timestamp wins, with millisecond resolution. Loser sees a "candidate already submitted" message and their submission is recorded for audit but not counted. |
| Candidate previously rejected from Kyndryl 6 months ago, now re-submitted by Partner B | If 90-day window from prior submission has lapsed, Partner B gets fresh ownership. If not lapsed (rare, 6-month-rejection means prior partner's window has long expired), Partner B gets fresh ownership. |
| Candidate self-applied directly 30 days before any partner submission | Direct application creates a record but no ownership claim (no fee owed). If a partner subsequently submits the same candidate, the partner's submission is **invalidated** because the candidate is already in HireOps. Direct-applied candidates are protected from retroactive partner claims. |
| Partner submits same candidate to two different reqs simultaneously | Allowed. Each submission is tracked separately; ownership applies to whichever req results in hire first. |
| Candidate applies directly while in an active partner ownership window | Partner ownership stands; direct application is logged but does not displace partner. |
| Empanelled partner A submits → ownership lapses → ad-hoc agency emails same CV → HireOps re-creates dedup-matched record | Ad-hoc submissions never carry ownership (no MSA backing). Candidate becomes available for direct sourcing. |
| Disputed ownership (partners disagree) | Manual review queue. Kyndryl admin sees full submission history with timestamps and resolves with audit trail. Default ruling: timestamp wins. |
| Candidate submitted to a req that gets cancelled | Ownership transfers to the speculative talent pool for the remainder of the 90-day window. |

#### Non-disclosure of ownership status to other partners

Other partners attempting to submit the same candidate are not told **who** owns the candidate. They see only "candidate already in pipeline." This protects partner confidentiality.

### 6.5 Ad-hoc partner intake (email-based)

For partners without portal access:

1. Kyndryl operates a per-partner email alias: `partner-acme-cvs@kyndryl-hireops.com`. Each empanelled-but-not-portal-using or ad-hoc partner gets their own alias for attribution.
2. Inbound email is parsed by an ingest worker:
   - Extract CVs from attachments (PDF/DOC/DOCX)
   - Extract subject line / body for req hint, candidate name, contact info
   - Resume-parser fills in the rest
3. Each parsed candidate creates a record with `source_partner_id` set to the alias's owning partner.
4. If submission is for a specific req (mentioned in subject/body or via a unique alias per req), it routes there. Otherwise lands in talent pool.
5. Same dedup + ownership rules apply, but ad-hoc partners get **a flat reduced fee** (or no fee, depending on MSA — most ad-hoc engagements are pay-per-hire-only with lower rates).

### 6.6 Communication guardrails

Partner-to-candidate communication is necessary (partners coach their candidates, prep them for interviews, manage logistics) but is also the highest-risk surface for misuse. Required controls:

- All messages logged in HireOps, viewable by Kyndryl admin
- Outbound messages from partner go through HireOps (not partner's own email) to enforce logging
- Inbound replies route back through HireOps, displayed to partner without leaking candidate's actual email
- LLM-based content scanner flags messages containing: alternative job offers, references to competing employers, requests for personal contact info outside the platform, derogatory references to Kyndryl
- Volume rate limits per partner-recruiter to prevent spamming

### 6.7 Partner SLA & performance management

| Metric | Target |
|---|---|
| Time-to-first-submission after req opens to partner | Empanelled: 48h. Ad-hoc: not measured. |
| Submission quality rate (passed initial screen) | Empanelled: ≥40%. Below this, partner is reviewed. |
| Hire conversion rate (submitted → hired) | Empanelled: ≥3%. Below this, panel review. |
| Partner exclusivity compliance | 100% — measured by zero double-submissions across vendors |
| Partner panel review cadence | Quarterly — empanelled partners with bottom-quartile metrics flagged for renegotiation or panel removal |

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

### 7.2 Day 0 — Workday hire sync (the critical integration moment)

This is where HireOps stops being the system of record and Workday takes over for that worker.

| Capability | Required behaviour |
|---|---|
| Pre-Hire creation in Workday | On offer-accept, create Workday Pre-Hire (SOAP `Put_Applicant` or staffing equivalent). |
| Hire Employee transaction | On Day 1, fire `Hire_Employee` SOAP. For volume: use `Import_Hire_Employee` (parallel-safe). |
| Position assignment | Map to Workday Position created upstream during requisition approval. |
| Compensation, location, reporting line | All synced as part of Hire transaction. |
| Idempotency & reconciliation | If Workday call fails, retry. Daily reconciliation: all Day-0 hires in HireOps must have Workday Worker IDs by Day 1 EOD. |
| Worker ID write-back | Workday Worker ID written back to HireOps employee record. Permanent linkage. |

### 7.3 Day 1 to Day 30

| Capability | Required behaviour |
|---|---|
| IT provisioning queue | Hand-off to IT persona. Laptop, email account, AD/Okta, Slack/Teams, role-based app access (Jira, Confluence, GitHub, AWS, etc.). Each step tracked. |
| Access provisioning via SCIM | Where possible, automate via SCIM to Okta/Azure AD/Google Workspace, which downstream provisions to apps. |
| Buddy / manager assignment confirmation | Manager confirms buddy paired, first 1:1 scheduled. |
| Training assignment | Mandatory compliance training (POSH for India, harassment training for PH/US, security awareness, code of conduct). LMS integration or built-in. |
| 7-day, 14-day, 30-day check-ins | Auto-scheduled with manager + People Ops. Pulse survey at 30 days. |
| Probation tracking | Default 3 or 6 months. Probation review milestone. Probation confirmation or extension. |

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
| Notice period management | Calculate based on grade + contract. India: typically 30/60/90 days. Approve early release, garden leave, buy-out. |
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
| Positions | WD → HireOps | On position create/update in WD | Near-real-time (webhook or 15-min poll) |
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
| **Bias / fairness reports** | Quarterly: selection rate by gender, age band, region. EEOC analogue if Kyndryl-US is in scope. |
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

### 9.6 Bulk operations (Lovable does not support this)

At 300/month a recruiter doing one-by-one operations cannot keep up. Required:

- Bulk move (50 candidates → next stage)
- Bulk reject (with templated rejection reasons + automated email)
- Bulk message (with personalisation tokens)
- Bulk schedule (slot-pool offered to N candidates, first-come-first-served)
- Bulk export to CSV
- Bulk import (CSV upload of candidate list from agency)

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
Goal: 300 hires/month sustained for 1 month before declaring POC successful, full partner panel of 20–30 vendors active.

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

## 12. Open questions for Kyndryl

These need answers before architecture is locked down. Listed in priority order.

1. **GCC location?** Affects compliance (DPDPA for India, Data Privacy Act 10173 for Philippines, etc.), data residency, holiday calendars, language, payroll integration partner.
2. **Workday tenant access?** Kyndryl-prod, Kyndryl-impl (sandbox), or net-new tenant for the GCC? When can we get ISU credentials and webhook setup?
3. **Kyndryl careers site?** Is HireOps-hosted careers page sufficient, or must apply originate on `careers.kyndryl.com`?
4. **SSO provider?** Okta, Azure AD, Kyndryl-internal IdP?
5. **BGV vendor?** Existing Kyndryl contract (HireRight / FirstAdvantage / AuthBridge / etc.) or vendor of our choice?
6. **Job-board contracts?** LinkedIn Recruiter seats? Naukri RMS account? Kyndryl-existing?
7. **IT provisioning systems?** What downstream — Okta SCIM? ServiceNow? Internal ticketing?
8. **Approval matrix?** Who approves what at what grade / cost? Kyndryl will have a documented matrix; we need it.
9. **Compensation bands & grade structure?** Required to drive comp recommendations.
10. **Production data residency requirement?** ap-south-1 (Mumbai) vs us-east-1 vs EU?
11. **SOC 2 / ISO 27001 timeline?** POC tolerance vs production blocker.
12. **Branding?** Kyndryl logo / colours / "powered by HireOps" positioning?
13. **Volume ramp?** 300/month from week 1 of go-live, or ramp from 50 → 150 → 300 over Q1?
14. **Languages?** English-only acceptable? Hindi / Tagalog needed for candidate portal?
15. **Partner panel size & composition?** How many empanelled partners are envisioned? Are we starting with the existing Kyndryl agency panel or building net-new?
16. **Partner MSA template?** Does Kyndryl have a standard MSA we should align the platform's commercial model to (fee structures, exclusivity terms, payment terms, dispute clauses)? If not, we're guessing on key data fields.
17. **Existing partner data?** Are there candidates already in flight via partners that need to be migrated in with ownership preserved?
18. **Partner panel governance?** Who at Kyndryl owns the partner relationship — TA Lead? Procurement? A separate Vendor Management Office? Drives admin permissions design.
19. **Invoicing & finance integration?** Does Kyndryl AP have an existing system we should integrate with for partner invoicing (SAP, Oracle, Coupa)? Or do partners invoice through email/PDF?
20. **Ad-hoc partner email aliases?** Will Kyndryl provision per-partner email addresses (`partner-acme-cvs@kyndryl-hireops.com`) or do we need a different attribution mechanism?

---

## 13. What this document is not

- It is not the architecture. That is in `architecture.md`.
- It is not the design system. That is a separate spec to follow, after Wave 1 stabilises core flows.
- It is not the project plan. That comes after Kyndryl signs off on scope.
- It is not final. Every requirement in here will move once Kyndryl shares their actual operating model. Treat this as a strong v0.1.
