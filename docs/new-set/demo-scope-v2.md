# HireOps — Demo Scope v2 (Week 13)

**Status:** Internal canonical demo script for late August 2026 Kyndryl
session. Replaces the earlier demo-scope.md draft entirely.

**Last updated:** 2026-05-28

---

## 1. Purpose

A capability + wedge demo for Kyndryl that lands three things:

1. **The platform works end-to-end.** Apply through simulated Workday hire,
   live, on a real staging environment.
2. **The wedge is real, not a slide.** HR-configurable agents handle
   scheduling, follow-ups, and candidate Q&A — visibly, with human-in-loop
   approval and full audit.
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

This is the new build from weeks 1-10. The differentiation.

| # | Action | Narration |
|---|---|---|
| 7 | Navigate to `/admin/workflows` as admin user | "This is HireOps' operating model. Recruiters don't operate the system — they direct it. Here's the admin workflows surface where HR configures what the platform does automatically." |
| 8 | Show list of active workflows — scheduling agent, follow-ups agent, candidate Q&A agent. Click into scheduling agent. | "Three agents configured for this tenant. Let's look at scheduling. You see the triggers — when a candidate hits the 'schedule interview' stage. The actions — propose three slots, send candidate a self-scheduling link. The approval rules — auto-send for standard scheduling, recruiter approves for VIP candidates." |
| 9 | Switch to recruiter view, advance the seeded candidate to "schedule interview" stage | "Recruiter advances the candidate. Behind the scenes, the scheduling agent picks up the trigger, queries the panel members' Google calendars, intersects availability, proposes three slots, drafts the candidate message." |
| 10 | Show approval queue with proposed scheduling message and 3 slots | "Recruiter sees the proposed action in the approval queue. They can approve, edit, or override the slot selection. Every approval is logged with who, when, and what data the agent used." |
| 11 | Approve, switch to candidate browser, open signed-link self-scheduling page, pick a slot | "Candidate gets the self-scheduling link. Picks a slot. Calendar invites fly out to the panel and the candidate." |
| 12 | Show calendar invites landing on recruiter's calendar and a panelist's calendar | "Real calendar integration. Google and Microsoft 365 both supported via OAuth." |
| 13 | Navigate to a separate seeded candidate stuck at "tech screen scheduled" for 5+ days. Show follow-ups agent has drafted a follow-up. | "Different candidate, different agent. This one's gone stale at tech-screen-scheduled. Follow-ups agent has drafted a check-in message. Recruiter approves, message sends, audit log records it." |
| 14 | Show one more — candidate Q&A. A candidate's question email surfaces in the approval queue with a drafted AI reply from the JD + tenant FAQ. | "Third agent. Candidate emailed a question — 'what's the salary range for this role?' Agent drafts a reply from the JD and the tenant's FAQ library. Recruiter approves, reply sends." |

### Act 3 — The audit + cost surface, then offer through hire (steps 15-19, ~7 min)

| # | Action | Narration |
|---|---|---|
| 15 | Open audit list view in admin | "Every agent action — proposed, approved, sent, logged here with the reasoning. This is what 'AI you can audit' looks like in practice. Procurement, risk, and assurance teams can verify any decision after the fact." |
| 16 | Open cost-per-feature dashboard | "Same data, different lens. Every Anthropic call logged with input tokens, output tokens, cost in INR. Per agent, per workflow, per recruiter. Procurement gets a real TCO number, not a vendor estimate." |
| 17 | Switch back to recruiter view, navigate to a seeded candidate with an offer extended | "Now let's close the loop. Candidate further along — offer extended. Recruiter sees the offer state, copies the candidate-facing signed link." |
| 18 | Open `/offer/[token]` in a separate browser as candidate, preview, accept with full-name match | "Candidate reviews the offer, accepts by typing their full name. Click-is-acceptance for the POC — real e-signature integration is in the onboarding scope." |
| 19 | Show `/admin/integrations` with the simulated Workday Hire response carrying `simulation_notes` marker | "Acceptance triggers the Workday Hire workflow. Right now this is a simulator — you can see the `simulation_notes` field marking it as such, deliberately visible. The real Workday SOAP connector is in the onboarding scope, gated on your sandbox tenant credentials." |

---

## 3. What's deliberately not in the demo

Each gap is pre-framed as deliberate scope, tied to either the onboarding
window or the post-POC roadmap.

| Gap | Pre-framing |
|---|---|
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
- `pii_access_log` shipped only at week 7 of the 13-week build, was not
  in Wave 1
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

**Calendar OAuth failing during the live scheduling demo (step 9-11).**
Production Google / Microsoft OAuth flows occasionally have transient
failures. Mitigation: pre-test on the morning of the demo. Have a
pre-seeded candidate with calendar invites already set up as backup —
if live OAuth fails, narrate "let's look at a candidate who's already
been through this flow" and click the seeded one.

**Anthropic API latency spike during follow-up draft (step 13) or Q&A
draft (step 14).** AI-03 baseline is ~9 seconds; spikes can hit 15-20.
Mitigation: the approval queue surface shows "agent is drafting…" state.
If it takes longer than 12 seconds, narrate the cost / audit data while
waiting.

### Medium risk

**Empty pre-seeded data in admin workflows page.** If the seed script for
demo hasn't populated the three workflows visibly, step 8 falls flat.
Mitigation: explicit pre-demo checklist verifies seed completeness.

**SLA-imminent scanner firing during the demo creating unexpected
notifications.** The scheduled scanner runs every 15 min. Could create
mid-demo noise. Mitigation: pause the scanner during the demo window or
ensure no candidates are within SLA-imminent thresholds in the demo
data.

### Low risk

**Email landing in spam.** Resend with verified DKIM/SPF/DMARC should
handle this, but enterprise inboxes vary. Mitigation: test the demo
inbox a day prior; have a backup screenshot if the live demo email
delays.

---

## 6. Pre-demo checklist (week 13 day 1)

- [ ] Staging environment up and reachable
- [ ] DNS records all green (SPF, DKIM, DMARC verified at Resend)
- [ ] Demo tenant seeded fresh — 5 candidates at varied lifecycle stages,
      1 live-submit slot reserved, 3 active workflows configured
- [ ] Mobile browser and laptop both logged out
- [ ] Candidate persona email inbox accessible to demo audience (or
      mirror-screen)
- [ ] Backup recording of full flow captured (run-through, mp4)
- [ ] Calendar OAuth tested on demo morning with the actual panel
      members' calendars
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
