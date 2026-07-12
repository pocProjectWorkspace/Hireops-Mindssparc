# HireOps — Demo Scope v2 (Week 13)

**Status:** Internal canonical demo script for late August 2026 Kyndryl
session. Replaces the earlier demo-scope.md draft entirely.

**Last updated:** 2026-07-12 — Act 2 rewritten under the week-7
contingency decision (HANDOVER §0): scheduling and candidate Q&A are
cut from the demo to the onboarding window; the follow-ups agent is
taken end-to-end and is the wedge on stage. Act 2 now narrates only
what is built and verified on the branch.

---

## 1. Purpose

A capability + wedge demo for Kyndryl that lands three things:

1. **The platform works end-to-end.** Apply through simulated Workday hire,
   live, on a real staging environment.
2. **The wedge is real, not a slide.** An HR-configurable follow-ups agent
   notices stalled candidates on its own, drafts with Claude, waits for a
   human, sends, and logs everything — approval and audit visible live.
   (Scheduling and candidate Q&A agents are onboarding-window scope; the
   runtime they share is what's being demonstrated.)
3. **The roadmap is credible.** What's not yet shipped is honestly framed
   as onboarding-window or post-onboarding work, not hidden.

Success criteria:

- Kyndryl sees the wedge working live, not just promised.
- If a code or architecture walkthrough happens, the codebase reads as a
  coherent platform with deliberate phased scope, not a half-built
  prototype.
- Rajesh and Lakshmi have a defensible answer to every "what about X"
  question.
- Kyndryl is ready to sign the POC contract within 1-2 weeks of the
  session.

---

## 2. The demo flow

Three acts. ~25-30 minutes total at a comfortable narration pace, including
pauses for questions.

### Act 1 — The platform works (steps 1-6, ~8 min)

This is the working core that's been shipped since Phase 1 + 2. Familiar
ATS lifecycle, shown competently.

| # | Action | Narration |
|---|---|---|
| 1 | Open mobile browser to `/t/kyndryl-poc/apply/gcc-blr-senior-backend` | "What a candidate sees when they click an apply link. Mobile-first by design — most candidates apply from phones. Path-based tenant scoping; every Kyndryl URL starts with `/t/kyndryl-poc/`." |
| 2 | Fill name, email, phone, upload resume, attest DPDPA consent, submit | "Minimum-friction form. No notice period or CTC asked upfront — those are recruiter-screen questions." |
| 3 | Show confirmation page with reference number, switch to email inbox showing application-received email | "Confirmation page with reference. Confirmation email lands in seconds — that's the Resend integration, real sending domain with verified DKIM/SPF/DMARC." |
| 4 | Switch to laptop, log in as `recruiter1@kyndryl-poc.test` to `/triage` | "Recruiter view. Two-zone triage — Hot Zone for SLA-breached candidates needing attention, Momentum Feed ordered by AI fit score." |
| 5 | Open drawer for the just-submitted candidate, show AI score + factors + parsed CV | "Candidate just submitted. Scored by Claude — top contributing factors, parsed skills, original CV. Scoring is async; doesn't block the candidate's submit." |
| 6 | Brief pause, take any questions on the core flow | — |

### Act 2 — The wedge (steps 7-14, ~12 min)

The follow-ups agent, end-to-end: configure → notice → draft → approve →
send → audit. One agent shown deeply beats three shown thinly — every
minute of this act is the same runtime that scheduling and Q&A will run
on in the onboarding window, and the narration says so once, up front.

Pre-seeded state (one `pnpm db:seed:demo-data` run): **Rohan Desai**,
stuck 7 days at tech-interview, with the agent's drafted check-in already
pending in the approval queue; **Meera Nair**, 6 days stale, untouched —
she is the optional live-fire target.

| # | Action | Narration |
|---|---|---|
| 7 | Navigate to `/admin/workflows` as admin user | "This is HireOps' operating model. Recruiters don't operate the system — they direct it. Here's where HR configures what the platform does automatically. No engineering involved: this agent was configured through this screen." |
| 8 | Click into the follow-ups agent. Walk the detail: trigger, two actions, approval rules, run history. Flick the enable toggle off and back on. | "One agent live for this tenant. The trigger: a candidate sitting in tech-interview for more than 5 days. The actions: draft a check-in with Claude, then send it. Look at where the approval sits — on the *draft*, not the send. A human approves the words; once approved, sending is mechanical. And HR can pause the whole agent with one switch." |
| 9 | Switch to recruiter view. Show Rohan Desai in `/triage` — 7 days in tech-interview. | "Rohan has been waiting 7 days. Nobody flagged him — no recruiter had to remember. Every 15 minutes the platform scans for exactly this and wakes the agent itself. That already happened." |
| 10 | Open `/approvals`. The drafted check-in for Rohan is waiting: subject, friendly body, the trigger context visible. | "Here's what the agent did about it: a drafted, personalised check-in — the role, how long he's waited, a friendly tone HR chose in the config. It has NOT been sent. It's waiting for a human." |
| 11 | Edit one line of the draft (make it personal), then Approve & send. | "The recruiter is the editor, not the typist. I'll tweak one line — and approve. The edited version is what ships; both versions are kept for audit." |
| 12 | Switch to the candidate inbox; the email lands. | "Seconds later it's in Rohan's inbox — real delivery over our verified sending domain. The recruiter spent forty seconds on something that used to silently not happen." |
| 13 | *(Optional live-fire — do only if the morning rehearsal was clean.)* Back as admin: show Meera Nair, 6 days stale, no run yet. Narrate the scanner cadence; if a tick fires during the act, her draft appears in the queue live. | "Meera is in the same position and the agent hasn't touched her yet — watch the queue. This is the platform noticing on its own, live. (Fallback if the tick doesn't land on cue: 'her check-in will be drafted within the quarter hour — this is Rohan's flow from ten minutes ago, on schedule.')" |
| 14 | Return to the agent's run history in `/admin/workflows` — the completed run: triggered by system → drafted → approved → sent. Pause for questions. | "The whole story in one row: the system triggered it, Claude drafted it, a named human approved it at a timestamp, the send completed. Hold that thought — Act 3 shows this same trail from the auditor's chair." |

### Act 3 — The audit + cost surface, then offer through hire (steps 15-19, ~7 min)

| # | Action | Narration |
|---|---|---|
| 15 | Open `/admin/audit`. Click the "Agent activity" filter. Expand the row for the approval decision — changed columns, before/after diff, who, when. | "Every agent action — proposed, approved, sent — logged with the full data diff. This is what 'AI you can audit' looks like in practice: the edit the recruiter made in Act 2 is right here, before and after, with the approver's identity and timestamp. Procurement, risk, and assurance can verify any decision after the fact." |
| 16 | Open `/admin/costs` — tiles, per-feature and per-model tables, the 14-day bars. | "Same data, different lens. Every Claude call logged with input tokens, output tokens, and cost — per feature, per model, per day. That draft you just approved cost a third of a US cent. Procurement gets a real TCO number, not a vendor estimate." |
| 17 | Switch back to recruiter view, navigate to a seeded candidate with an offer extended | "Now let's close the loop. Candidate further along — offer extended. Recruiter sees the offer state, copies the candidate-facing signed link." |
| 18 | Open `/offer/[token]` in a separate browser as candidate, preview, accept with full-name match | "Candidate reviews the offer, accepts by typing their full name. Click-is-acceptance for the POC — real e-signature integration is in the onboarding scope." |
| 19 | Show `/admin/integrations` with the simulated Workday Hire response carrying `simulation_notes` marker | "Acceptance triggers the Workday Hire workflow. Right now this is a simulator — you can see the `simulation_notes` field marking it as such, deliberately visible. The real Workday SOAP connector is in the onboarding scope, gated on your sandbox tenant credentials." |

---

## 3. What's deliberately not in the demo

Each gap is pre-framed as deliberate scope, tied to either the onboarding
window or the post-POC roadmap.

| Gap | Pre-framing |
|---|---|
| **No scheduling agent** | "Interview scheduling is the next agent on this same runtime — it needs calendar OAuth (Google + Microsoft), which we deliberately scoped to the onboarding window so we integrate against *your* tenant's calendars, not a demo account. The trigger/action/approval machinery you just watched is the hard part, and it's live." |
| **No candidate Q&A agent** | "Same story: the Q&A agent drafts replies to candidate emails from the JD and your FAQ library. Inbound email intake is schema-ready (`candidate_inbound_messages`); the agent lands in onboarding on the runtime you saw." |
| **No partner portal** | "Partner channel is in the onboarding scope. We modeled the schema for partner identity and assignment but want to design the UI with you — partner workflows vary per company." |
| **No JD builder UI** | "Requisitions are seeded for the demo. Recruiter-facing JD builder with AI generation is in the onboarding scope." |
| **No approvals enforcement on requisitions/offers** | "Approval schema is shipped. Enforcement layer is in the onboarding scope, deliberately deferred so we model your actual approval matrix with you." |
| **No interview AI features beyond scheduling** | "Live interview operations — pre-interview briefs, post-interview AI summaries from transcript — is in onboarding. Transcripts come from Zoom/Teams; we don't build our own video stack." |
| **No onboarding / offboarding flows** | "Out of POC scope by design. The POC covers application through Workday Hire. Onboarding and offboarding are separate product surfaces, on the post-POC roadmap." |
| **Admin surface limited to workflows + integrations + audit + cost** | "Other admin surfaces — users/roles, branding, bias detection rules, AI model configuration — expand during the onboarding window." |
| **One portal — internal — for the demo** | "Candidate-facing surfaces are the apply form and signed-link pages, both shown live. Candidate portal with status tracker, partner portal, and the SEO careers site are on the roadmap." |
| **Workday is a simulator** | "Real connector in onboarding, gated on your sandbox credentials." |
| **E-signature is click-is-acceptance** | "Real e-signature in onboarding. Provider TBD — happy to use your existing enterprise agreement (DocuSign, Adobe Sign) or recommend Signzy for DPDPA-aware Indian e-sign." |
| **OpenAI provider not smoked** | "Anthropic is the default. OpenAI is wired but not yet verified against live API. We smoke that path before any tenant prefers OpenAI." |

---

## 4. If they ask for a code or architecture walkthrough

Same approach as draft v1 — lean in on strengths, be honest about gaps.

### Lead with

- **Multi-tenant isolation** — FORCE RLS on every tenant-scoped table,
  compound `(tenant_id, id)` FKs, `withTenantContext` middleware.
- **Outbox + worker pattern** — notifications, Workday sync, AI scoring,
  and now agent actions all use the same outbox shape with `FOR UPDATE
  SKIP LOCKED` drains.
- **Signed-link primitive** — HMAC-SHA256, time-bounded, one-time-use.
  Candidates never need auth accounts.
- **AI client abstraction** — two providers, per-tenant routing,
  per-tenant credentials, full usage logging in `ai_usage_logs`.
- **Audit logs** — polymorphic, partitioned monthly, populated by hybrid
  trigger + `withTenantContext`.
- **Agent surface architecture** — workflows table with triggers and
  actions, approval rules per agent, run history with reasoning, all
  configurable via admin UI without engineering involvement. This is
  the wedge in code.
- **`simulation_notes` honesty marker** — engineering discipline signal.
  Simulation is never invisible.

### Be honest about

- OpenAI provider not yet smoked against live API
- `pii_access_log` is still pending (targeted before the demo; if it
  slips, say so plainly — the audit_logs + api_audit_logs pair covers
  data changes and API intent today, read-access logging is the gap)
- Scheduling + candidate Q&A agents were descoped at the week-7
  checkpoint to take follow-ups end-to-end — a deliberate depth-over-
  breadth call, and the contingency plan working as designed
- Real Workday SOAP connector is in onboarding scope
- Real e-signature is in onboarding scope
- Coverage isn't measured yet — coverage gates added during onboarding

### Deflect

- Reporting / analytics — "post-POC roadmap, scoped against your actual
  metrics needs"
- Mobile recruiter app — "recruiter is desktop-first by design"
- Specific feature requests not in current scope — "happy to discuss as
  onboarding scope or roadmap"

---

## 5. Known live-demo risks and mitigations

### High risk

**Live-fire timing on step 13 (Meera).** The stage_stale scanner ticks
every 15 minutes and the draft then needs a real Anthropic call
(baseline ~9s, spikes 15-20s). The tick will usually NOT land inside the
act. Mitigation: step 13 is explicitly optional with a scripted fallback
line; Rohan's pre-seeded approval (step 10) carries the act regardless.
Never block the demo waiting for a tick.

**Demo state consumed by a test run.** `pnpm test:gate` defensively
wipes the seeded wedge state (pending approval, outbox rows) and the
scan-test can enqueue stray rows against the demo agent. Mitigation:
**run `pnpm db:seed:demo-data` AFTER any test run and immediately before
the demo** — the seed is idempotent and rebuilds the entire Act-2 state
in one command. This is a hard runbook rule.

### Medium risk

**Anthropic latency during any live draft.** If a live draft is in
flight and slow, narrate the audit/cost surfaces while waiting — they're
one click away in Act 3 and make the pause look intentional.

**Empty pre-seeded data in admin workflows page.** If the seed hasn't
run, step 8 falls flat. Mitigation: the pre-demo checklist verifies the
agent, both stale candidates, and the pending approval exist (the seed
prints all four ids in its summary).

**SLA-imminent scanner firing during the demo creating unexpected
notifications.** The scheduled scanners run every 15 min. Could create
mid-demo noise. Mitigation: ensure no demo-data candidates sit inside
SLA-imminent thresholds, or accept the noise and narrate it as the
platform working.

### Low risk

**Email landing in spam.** Resend with verified DKIM/SPF/DMARC should
handle this, but enterprise inboxes vary. Mitigation: test the demo
inbox a day prior; have a backup screenshot if the live demo email
delays.

---

## 6. Pre-demo checklist (week 13 day 1)

- [ ] Staging environment up and reachable
- [ ] DNS records all green (SPF, DKIM, DMARC verified at Resend)
- [ ] Demo tenant seeded fresh via `pnpm db:seed:demo-data` — run AFTER
      the last test run, never before one. Verify the seed summary
      prints: the follow-ups agent (enabled), Rohan (7d stale, pending
      approval), Meera (6d stale, no run), 1 live-submit slot reserved
- [ ] Demo tenant has a real Anthropic credential
      (`ai_anthropic` via storeIntegrationCredential) — live drafts and
      scoring depend on it; the pre-seeded approval does not
- [ ] Workers process running on staging (the scanner and send path
      both live there); email template changes require a worker restart
- [ ] Mobile browser and laptop both logged out
- [ ] Candidate persona email inbox accessible to demo audience (or
      mirror-screen)
- [ ] Backup recording of full flow captured (run-through, mp4)
- [ ] Anthropic API budget alerts not at threshold (avoid mid-demo
      throttling)
- [ ] All open critical issues either fixed or known and documented
- [ ] Rajesh and Lakshmi have read this doc and the build-plan; they
      can answer follow-up questions in their channels independently

---

## 7. What we want from Kyndryl at end of demo

Explicit:

- Verbal commitment to move to POC contract within 1-2 weeks
- Names of stakeholders for SSO/IdP setup (week 1 of onboarding)
- Confirmation of Workday sandbox availability (week 4 of onboarding)
- Preferred e-signature provider (week 4-5 of onboarding)
- Initial cohort of requisitions to seed during onboarding (week 6)

Implicit:

- Their level of engagement during the wedge demo (act 2). Low
  engagement = wedge isn't landing; need to recalibrate the positioning
  before next conversation. High engagement = wedge is the thing; lean
  into it for the contract negotiation.
- Whether they ask for things not in the demo. Notes from these
  questions feed directly into `post-demo-onboarding.md`.

---

## 8. Out of scope for this document

- The 13-week build sequencing → `build-plan-13week.md`
- The onboarding work after they say yes → `post-demo-onboarding.md`
- Prototype rewrite specifics → `prototype-rewrite-plan.md`
