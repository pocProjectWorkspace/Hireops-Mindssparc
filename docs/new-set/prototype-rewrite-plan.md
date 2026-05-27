# HireOps — Prototype Rewrite Plan

**Status:** Internal working document. Drives the Lovable rework session in
weeks 11-12 of the build plan. Specific edits to bring the
`procurve-ai.lovable.app` prototype in line with where the build is
landing.

**Why this exists:** the prototype audit (2026-05-27) found that the
prototype and the build are describing different products. The prototype
over-promises features (six portals, AI voice, predictive insights, live
interview NOC) that aren't being built. The build under-surfaces what it's
actually doing (working apply form, AI scoring with discriminator, Workday
integration shape, partner data model). Demo viewers cross-referencing the
prototype against a code walkthrough would see the dissonance.

This document fixes that.

**Last updated:** 2026-05-28

---

## 1. Principles for the rewrite

1. **Match the prototype to where the build will be at demo date (week
   13)**, not where it is today. The wedge surfaces will be shipped by
   then.
2. **Honesty markers stay.** The prototype already uses "Disconnected"
   for AI Voice Agent and "Coming Soon" for AI Report Scheduler. Extend
   that pattern — anything not shipped at demo gets a marker.
3. **Don't claim what we won't deliver.** If a feature isn't on the
   roadmap inside 12 months, drop it from the prototype rather than
   labelling "Coming Soon" forever.
4. **Surface what's actually built.** The build's investments in
   tenancy, audit, outbox, partner schema, Workday integration are real
   but invisible in the prototype. Some of them should be visible.
5. **Preserve the wedge framing.** The prototype's "Admin Workflows"
   page is the closest thing to wedge framing. Strengthen it, don't
   weaken it.

---

## 2. Drop entirely

These tiles/screens get removed from the prototype. Each is either out
of scope, contradicts positioning, or was prototype-only theatre.

| # | Item | Where in prototype | Why removed |
|---|---|---|---|
| 1 | **External ATS bi-directional sync (Greenhouse)** | Integrations panel | Contradicts positioning. HireOps IS the ATS, not a layer on top. |
| 2 | **Outbound webhooks (3 endpoints)** | Integrations / system setup | Not on roadmap. Will be customer-specific when needed. |
| 3 | **Predictive Insights — Health Score / Hiring Difficulty / Offer Acceptance Probability** | Owner + HR Head dashboards | Requires data that doesn't exist yet. Explicitly POC-dropped per requirements §10.2/§10.3. |
| 4 | **Feasibility Reports** | Owner / HR Head | Same. POC-dropped per requirements §10.3. |
| 5 | **Live Interview Monitor (packet loss / AI signals / NOC view)** | Panel persona | Wrong feature. The useful version is Interview Operations (see Reframe section). |
| 6 | **Real-time captions + translation in interview rooms** | Landing hero stat + Panel | Use Zoom/Teams native captions when interview scheduling exists. Not a HireOps feature. |
| 7 | **In-app video interview rooms (WebRTC)** | Multiple panel/recruiter routes | Architecture §8.3 explicitly says no custom WebRTC. Integrate Zoom/Teams. |
| 8 | **24/7 Candidate AI Coach (mock interviews, STAR)** | Landing hero stat + Candidate routes | Different product line. Acknowledged as separate B2C conversation in product strategy. Not core platform. |
| 9 | **Candidate OTP signup** — *wait, this stays* | — | This is the only "drop" item that's actually being kept; see §3. |
| 10 | **Candidate AI Coach related: Applications tracker, Notifications feed, Settings under candidate-portal** | Candidate routes | No candidate portal app planned for Wave 1 / pre-demo. Apply form and signed-link pages cover demo needs. |

---

## 3. Keep but reframe

These items stay in the prototype but the framing, label, or content
changes.

| # | Item | Current framing | New framing | Notes |
|---|---|---|---|---|
| 1 | **Live Interview Monitor** → **Interview Operations** | "Real-time sessions with packet loss, AI signals, escalate-to-HR-Head" | "In-progress interview visibility — runtime, attendance, feedback SLA, post-interview AI summary" | Build the *useful* features (calendar + Zoom webhook based), drop the *theatre* features (packet loss). |
| 2 | **AI Voice Agent — phone screening** | "Disconnected" tile in Integrations | Keep "Disconnected" label, add "Pilot Q1 2027" or similar timeline | Honesty marker stays. Don't promise sooner than we can ship. |
| 3 | **AI Report Scheduler** | "Coming Soon" tile in Admin Dashboard | Either keep "Coming Soon" or drop. **Decision:** drop unless we commit to scheduled reports by Q2 post-POC. | Currently the only explicit "agents" reference is a Coming Soon placeholder, which is weak. Either ship something or remove. |
| 4 | **Six Dedicated Portals** (Landing hero) | "Six dedicated portals, one unified platform" | "Multi-persona platform — Recruiter, HR, Admin, with Candidate, Partner, and Panel surfaces on roadmap" | Honesty about what's shipped vs roadmap. Avoid the "six portals" claim that the build openly contradicts. |
| 5 | **Predictive analytics positioning** (Landing) | "AI-powered predictive insights" | "AI-driven recruiter operations — scheduling, follow-ups, candidate Q&A, reminders" | Reframe from prediction (which we're not building) to operations (which is the wedge). |
| 6 | **Candidate OTP signup** | Phone OTP with country code picker | Keep as-is | Validated by you for India market. Build in onboarding week 1 (Twilio / MSG91). |
| 7 | **Admin Workflows page** | "Control automation pipelines" with 12 named workflows + toggle/run-history | "Configure your HR agents — triggers, actions, approval rules, audit, cost" | Reframe to match the actual wedge surface. The 12 named workflows are replaced by whatever actually ships (Scheduling Agent, Follow-Ups Agent, Candidate Q&A Agent, Reminders Agent post-onboarding). |
| 8 | **Market Intelligence** | Tile on dashboard | Keep tile, label "Pilot" or "Coming H1 2027" | Genuine feature for post-POC if we commit to data licensing. Worth keeping in prototype as direction-of-travel signal. |
| 9 | **AI model + temperature + max-tokens config UI** | Sliders in Admin AI Settings | Reframe to "AI Provider Configuration" — model selection, provider routing (Anthropic / OpenAI), cost limits | Match what the build actually has (per-tenant `ai_provider` routing) rather than what the prototype shows (raw temperature sliders). |

---

## 4. Add (surface what's built but invisible)

These are inverse-drift items from the prototype audit. Built or
buildable, but the prototype doesn't show them. The demo demo flow
requires these to be visible in the prototype so the narrative aligns
when Kyndryl reviews both.

| # | Item | Where to add | Build support |
|---|---|---|---|
| 1 | **Public apply form flow** with QR-coded apply link surface | New screen / hero section: candidate apply via QR or URL | SHIPPED (CRS-01). Live demoable. |
| 2 | **AI Score discriminator** (`scored_by: anthropic / simulated / skipped`) and prompt_version audit | AI Shortlist screen, candidate detail drawer | SHIPPED (AI-03). Honesty marker; trust signal. |
| 3 | **Workday Integration Health** with `simulation_notes` honesty marker | Admin Integrations panel | SHIPPED (I8 / F4). Distinctive marker. |
| 4 | **Knockout evaluator** — deterministic pre-AI filtering | Apply form screen or admin requisition settings | SHIPPED (O2). Cost story — "we don't pay LLM tokens on candidates who fail dealbreakers." |
| 5 | **Reverse-mutation undo (30s server window)** | Recruiter triage screen — show toast/undo affordance instead of drag-drop kanban | SHIPPED (E4). Better audit semantics than drag-drop. |
| 6 | **Candidate-side offer accept via signed link** with mobile-first preview | Candidate offer screen | SHIPPED (M4). Mobile-acceptance moment is highly demoable. |
| 7 | **Approval Inbox** for agent decisions and offer/req approvals | Admin / HR Head persona | Building in weeks 1-2. Schema exists; tRPC + UI in build. |
| 8 | **Agent Run History + Audit View** with reasoning per decision | Admin Workflows + Audit screens | Building in weeks 1-2 + 6-7. Data exists in `audit_logs`, `ai_score_explanation`, `api_audit_logs`. |
| 9 | **Cost-per-feature / per-agent dashboard** | Admin AI Settings | Building in weeks 1-2. Data exists in `ai_usage_logs.cost_micros`. |
| 10 | **Per-tenant AI provider routing** | Admin AI Settings | SHIPPED (C1). Show toggle between Anthropic / OpenAI per tenant. |
| 11 | **SLA-imminent recruiter alerts** — example of an autonomous agent | Surface as a "working agent" example in Admin Workflows | SHIPPED (J6). Closest thing the build has to a running autonomous agent. |

---

## 5. Keep as-is

These prototype items already align with the build direction or are
roadmap-correct. No edits needed.

- AI Shortlist with criterion-by-criterion explanation
- Approval chains + inbox + SLA tracker + history (Approval Inbox add
  in §4 lands here)
- Multi-channel notifications surface (the framing — actual WhatsApp
  ships in onboarding)
- Email template editor (post-onboarding feature)
- Theme & Branding white-labelling (post-onboarding feature)
- Users & Roles management (post-onboarding feature)
- HR Cases (post-onboarding feature)
- Documents & Verification (post-onboarding feature)

---

## 6. Specific landing page edits

The prototype's landing page is the highest-stakes single screen. Edits:

### Hero copy

**Before:**
> "AI-powered Talent Acquisition Portal that automates hiring end-to-end
> — from requisition to offer — with smarter sourcing, scoring,
> scheduling, and interview intelligence."

**After:**
> "Enterprise hiring where HR teams direct the platform and AI does the
> operational work — scheduling, follow-ups, reminders, candidate
> questions — with human-in-loop approval and full audit."

### Hero stats (currently 4)

Drop:
- "24/7 Candidate Assistant"

Keep / reframe:
- "Multi-persona platform"
- "AI-driven operations" (replaces "AI-powered scoring")
- "Audit-by-default"

Add:
- "Built India-first"

### Feature pillars (currently emphasises sourcing, scoring, scheduling,
interview intelligence)

Replace with:
1. **HR-configurable agents** — workflows, triggers, actions, approval
   rules
2. **Recruiter operations** — scheduling, follow-ups, reminders,
   candidate Q&A
3. **Full audit + cost transparency** — every agent decision logged
   with reasoning
4. **Enterprise-grade isolation** — multi-tenant by design, DPDPA-aware,
   Workday integration

---

## 7. Sequencing for the rewrite

Rewrite happens in weeks 11-12 of the build plan, after wedge surfaces
are shipped. Reason: rewriting the prototype before the build catches up
means rewriting it again. One pass, done well, after the build is ready.

Specific session shape (estimated 6-10 hours of Lovable work across
weeks 11-12):

1. Drop the 10 items from §2 (~2 hours)
2. Reframe the 9 items from §3 (~3 hours)
3. Add the 11 items from §4 (~4 hours)
4. Landing page rewrite per §6 (~1 hour)
5. Pass-through review with Rajesh and Lakshmi (~1-2 hours)

Lovable's strength is fast iteration on screens; the slow part is
deciding what to ship. This document does the deciding so the Lovable
session is mostly mechanical.

---

## 8. What we don't do in the rewrite

- **Don't ship a new prototype URL.** Update the existing
  `procurve-ai.lovable.app` URL. Anyone who's seen the old version sees
  the updated version at the same link.
- **Don't try to make the prototype interactive with the build.**
  Prototype stays Lovable-only. Build stays separate. The two have
  visual alignment; they don't share data.
- **Don't replicate every build feature in the prototype.** Some build
  investment is correctly invisible (FORCE RLS, KMS envelope encryption,
  outbox internals). Keep the prototype as a *narrative* of the product,
  not a mirror of the codebase.
- **Don't add the rename ("HireOps" → new name) at this stage.** Per
  product strategy, rename is post-onboarding. Lovable prototype keeps
  the HireOps name until then.

---

## 9. Out of scope for this document

- Pitch deck / sales collateral derivatives → Rajesh and Lakshmi's
  work, not this plan
- Marketing site (separate from the product prototype) → not in scope
  for the POC; post-POC if at all
- Brand redesign → post-onboarding
