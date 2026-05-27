# HireOps — Product Strategy

**Status:** Internal canonical strategy document. Spine artefact — every other
POC document inherits from this. CP, Rajesh, Lakshmi all advocate from this.

**Last updated:** 2026-05-28

---

## 1. What HireOps is

HireOps is a **multi-tenant SaaS ATS** for enterprise hiring, built India-first
for the Global Capability Centre (GCC) market. Full ATS, not a layer on top
of anything else. Direct alternative to Greenhouse, Lever, Workday Recruiting,
Ashby for the segment we serve.

What makes HireOps different from those incumbents:

> **HR teams direct the platform; the platform does the operational work.**

The recruiter using Greenhouse today is an operator — they chase candidates,
schedule interviews, draft follow-ups, remind interviewers, update Workday,
field hiring-manager intake requests, answer candidate questions. They spend
most of their day on the unglamorous middle of the funnel.

HireOps inverts this. The recruiter becomes a director of work. The platform
runs configured agents that draft follow-ups, schedule interviews, send
reminders, triage tickets, update systems. The recruiter approves, edits,
intervenes when judgement is needed. Every action is logged with reasoning.

This is not "AI as a feature." It's the operating model of the platform.

---

## 2. The validated demand

Three companies independently asked for the same thing when shown the HireOps
prototype: **AI-driven operational support for hiring — interview scheduling,
follow-ups, reminders, tickets.**

This is the wedge. Not in our framing, in their framing. Three independent
asks for the same operational surface is market signal, not noise.

What this is **not**:
- "AI scoring" — that's table stakes; every incumbent shipped it in 2024-2025.
- "AI Voice Agent" — flashy but uncommon ask; defer until volume justifies.
- "Predictive insights / feasibility / market intelligence" — requires data
  that doesn't exist yet; defer or build as transparent heuristics.
- "Candidate AI Coach" — different product line (B2C), not core platform.

What this **is**:
- **Interview scheduling** — calendar-integrated, panel-aware, candidate self-
  serve, recruiter approval, rescheduling, reminders.
- **Follow-ups** — agent drafts the message, recruiter approves, message
  sends, audit logs the decision.
- **Reminders** — interviewer pre-panel briefs, candidate pre-interview
  prep, recruiter on stale items.
- **Tickets** — candidate Q&A drafted by AI, internal recruiter tasks, hiring
  manager intake routed to recruiters with context.

These four surfaces, configurable by HR (not by engineering), with human-in-
loop approval and full audit, are the proof-of-pattern of the wedge.

---

## 3. Market positioning

### Against Greenhouse / Lever / Ashby

Greenhouse and Lever are mature, US-built ATSs with strong ecosystems. Ashby
is newer, polished, well-engineered, AI-aware. All three handle the
*recruitment lifecycle* well — apply, triage, interview, offer, hire.

What none of them do well: take operational work off the recruiter's plate.
Greenhouse has integration marketplaces with Calendly and Gem; Ashby has AI
features bolted on; none have *HR-configurable agents as the operating model*.
Their architecture is built around recruiters operating the system, not
directing it.

HireOps is built for the inverted model from the ground up — outbox patterns,
worker drains, per-tenant AI provider routing, audit-by-default, approval
chains as a first-class primitive. The architectural commitment is what makes
the wedge feasible without rebuilding the platform later.

### Against Workday Recruiting

Workday Recruiting is enterprise-grade and integrated tightly with Workday
HCM. Its UX is widely criticised; its configuration requires implementation
consulting; its AI features are nascent. Customers buy it because they
already run Workday, not because Recruiting is best-in-class.

HireOps integrates with Workday (Hire SOAP today simulated, real connector in
build plan) but is built for the recruiter, not the HCM integration. The
customer who picks HireOps over Workday Recruiting does so because they want
the recruiter experience and the AI operational layer, while keeping Workday
as the system of record.

### Against Eightfold / Paradox / Gem

Eightfold (matching/sourcing), Paradox (conversational AI for candidates),
Gem (sourcing CRM) — each owns a slice. None is a full ATS. Customers using
them have a separate ATS underneath.

HireOps doesn't compete with these directly. The closest overlap is Paradox's
candidate-conversational-AI, which HireOps will eventually have as a feature
(candidate Q&A ticket surface) but not as the core product.

### Why India-first / GCC market

DPDPA-aware architecture from day one. Mumbai prod when ready. Sending domain
discipline. Partner channel as a first-class concept (Indian recruitment is
agency-heavy in ways US incumbents handle poorly). Working language and
defaults aligned to Indian recruiting norms. Pricing structure compatible
with INR enterprise procurement.

GCCs specifically are the target because they have US-comparable hiring
volume and sophistication but pain points US ATSs don't address well —
partner-heavy pipeline, Workday HCM integration into India payroll, DPDPA
compliance, multi-region panel scheduling.

---

## 4. The wedge in one paragraph (for pitch use)

> HireOps is a full multi-tenant ATS built for enterprises whose recruiters
> spend their day on operational work — chasing candidates, scheduling
> interviews, drafting follow-ups, fielding intake requests. HireOps inverts
> that: HR teams configure agents that do this work, recruiters approve and
> direct, every action is logged with reasoning. Built India-first for the
> GCC market, architecturally committed to the inverted operating model from
> day one rather than bolting AI onto an existing ATS.

---

## 5. What HireOps is not

To prevent drift in the next few months, write these down:

- **Not a Greenhouse companion.** No bidirectional sync. HireOps is the ATS.
  One-time data import from Greenhouse for migrating customers is in scope.
- **Not a workflow layer on top of multiple ATSs.** That's a different product.
- **Not a candidate-facing B2C product.** "HireOps Candidate" (a hypothetical
  paid job-seeker service) is a separate product line conversation, not a
  feature of the enterprise platform.
- **Not a video interviewing platform.** Zoom/Teams/Meet integration only;
  no custom WebRTC.
- **Not a sourcing tool.** LinkedIn/Naukri/Indeed multi-channel sourcing is
  on the roadmap as a feature, not the core differentiator.
- **Not a mobile-first recruiter product.** Recruiter is desktop-first by
  design; candidate-facing surfaces are mobile-first.

---

## 6. Customer / company shape

- **Anchor customer:** Kyndryl, paying POC, becomes Tenant #1 in production.
  Demo target late August 2026. Kyndryl is funding the build through the POC
  contract; this is multi-month engagement, not a transactional sale.
- **Team:** CP building. Rajesh and Lakshmi on client-side discussions and
  strategy. All three aligned on product direction.
- **Working language:** terse, decisive, lowercase in chat. Plain prose,
  British spelling in artefacts. Honest about uncertainty. No sycophancy.

---

## 7. Decision log

Decisions locked as of 2026-05-28:

- HireOps is a full ATS (not a layer on top of Greenhouse or Workday).
- Wedge is HR-configurable AI agents for hiring operational work.
- Four surfaces define the wedge: scheduling, follow-ups, reminders, tickets.
- Tickets surface includes candidate Q&A + internal recruiter tasks + hiring
  manager intake (three distinct sub-surfaces — sized accordingly in the
  build plan).
- India-first / GCC market positioning. Mumbai prod when ready.
- Kyndryl is the anchor POC; late August 2026 demo target.
- HireOps rename happens post-onboarding, not before demo.
- Solo build by CP for the 13-week pre-demo window.
- AI Voice Agent, predictive insights, candidate AI coach, external ATS
  sync, outbound webhooks — all explicitly out of scope for demo.

Decisions not yet made (escalate when relevant):

- E-signature provider for production offer acceptance.
- Specific Workday Hire payload schema for Kyndryl's tenant.
- Pricing structure for the POC and subsequent tenants.
- Market Intelligence data provider (LinkedIn / Lightcast / scrape / aggregate).
- Multi-channel sourcing implementation order (LinkedIn vs Naukri vs Indeed
  first).
- Candidate OTP signup provider (Twilio / MSG91 for Indian SMS).

---

## 8. This document's relationship to the others

- **`build-plan-13week.md`** — the realistic 13-week sequencing to ship the
  wedge proof-of-pattern and demo-credible core.
- **`demo-scope-v2.md`** — the click-by-click demo at week 13.
- **`post-demo-onboarding.md`** — what gets built and configured after
  Kyndryl says yes.
- **`prototype-rewrite-plan.md`** — specific edits to the Lovable prototype
  to align with where the build is heading.

If any of those four contradict this one, this one wins. If this one is
wrong, it gets updated and the others follow.
