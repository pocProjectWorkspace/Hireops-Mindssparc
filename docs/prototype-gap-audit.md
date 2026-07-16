# Prototype gap audit — procurve-ai-main vs built HireOps

**Date:** 16 July 2026. **Trigger:** post-demo direction — the client expects the full platform, and the user played back missing personas (hiring manager/requestor, HR head, candidate login, interviews, scheduling). A full read-only audit of the frontend prototype (`~/Desktop/Workspace/procurve-ai-main`, the Lovable export, branded "HireOps AI") was run on 16 July; this doc is the mapping of that inventory against the real platform, and the re-planned build sequence.

**Prototype reality check (matters for scoping):** the prototype is `DEMO_MODE=true` throughout — role-picker auth, static mock data, no shared state, and most write actions (including the HR Head's "Submit Decision" approve/reject button) have **no handler at all**. It narrates seven personas convincingly but persists nothing. It also has THREE inconsistent interview-recommendation vocabularies and two candidate-stage enums. So it is a **UX/scope reference, not a spec** — the real build keeps its surface map but standardises the semantics.

## 1. Persona-by-persona gap map

| Prototype persona | Prototype surface (what it narrates) | Built in HireOps | Verdict |
|---|---|---|---|
| **requirement_owner** (hiring manager / requestor) | 6-step requisition wizard (basics → AI JD → skill weights → psychometrics → interview rounds → submit), JD builder (real LLM), JD library, approval tracker, candidate assessment, insights | Schema ready (`requisitions`, `jd_versions`, `jd_skills`, `requisition_knockouts`, positions/envelopes) but **no creation surface and no owner persona** — reqs exist only via seed | **~90% missing surface; schema ~ready** |
| **hr_head** | Approval queue with decision form (approve/send-back/reject + headcount/budget/priority), pipeline, analytics, governance, market-intel/feasibility (static AI facade) | `approval_chains/matrices/requests/decisions` tables exist **unwired**; no persona, no queue | **Missing; schema ready. Note: prototype's own approve button is dead — we'd be first to make it real** |
| **recruiter** | Dashboard, candidates, shortlist tiers, scheduling, interview room, missing-info tracker, analytics | **Largely built and better**: triage (Hot Zone+Momentum), real AI scores + explanations, offer flow, approvals (agent), reports partial | Gaps: interview scheduling, missing-info tracker (defer), pipeline kanban (defer) |
| **panel** (interviewer) | My interviews, pre-brief, interview room (real getUserMedia), scorecard (5 criteria 1–5 + recommendation), feedback list, history, live monitor (pure facade) | **Nothing** — no interview tables at all (requirements §5.5 ~5%) | **Missing entirely; no schema** |
| **hr_team** | Case board post-technical, HR rounds, comp recommendation (Proceed/Negotiate/Need Approval vs band), offer pipeline w/ HR-head escalation, docs verification, templates | Offers (draft/extend/accept/sim-hire) real; docs verification real (ONBOARD-05, recruiter-side); onboarding cases real (beyond prototype!) | Gaps: HR-round-as-interview-type, comp bands + out-of-band approval escalation (defer), case board (partially = triage+onboarding) |
| **candidate** | Signup (phone+OTP), login, dashboard w/ stage stepper, applications, interviews view + room, document upload, AI coach, notifications | Public apply form + signed-link offer accept only. **No account/login, no dashboard, no candidate doc upload, no offer visibility in-portal** (prototype ALSO lacks apply + offer accept — we're ahead there) | **Account + dashboard + docs missing** |
| **admin** | Users/roles CRUD, AI settings, integrations, branding, audit (CSV export), bias rules, workflows monitor, WhatsApp messaging center, system setup | **Built and real where it counts**: workflows, audit (real data), costs, integration health | Gaps: users/roles mgmt (small, useful), AI settings UI, bias shield, branding, messaging (all defer post-POC) |

**Built beyond the prototype** (worth saying out loud to the client): partner portal + submission with ownership/dedup, full onboarding pillar with Day-0 Workday sim, real agent wedge with human-in-the-loop approval, real audit/PII logging, real multi-tenancy + RLS. The prototype has none of these.

## 2. Cross-cutting gaps
- **Interview scheduling/calendar:** prototype's one real widget (date/time/duration/mode/panel picker) persists nothing; no calendar integration anywhere. Real build: schedule against interview tables + signed-link candidate confirmation; external meeting URL as a field; true calendar sync deferred.
- **In-app notifications:** all mock in prototype; HireOps has email outbox only. Defer bell to polish.
- **i18n EN+AR** exists in prototype candidate auth; HireOps 0%. With France/Germany GCC targets, FR/DE eventually matter more than AR. Defer.
- **WhatsApp, bias shield UI, market-intel/feasibility "AI":** facade in prototype; defer (feasibility/market-intel are static strings even there).

## 3. Re-planned build sequence (agreed direction: these before offboarding)

**Wave A — the approval spine (requirement_owner + hr_head personas).** REQ-01 roles + surfaces skeleton (memberships already carry roles; add `requirement_owner`, `hr_head` to seed + role-aware nav), REQ-02 requisition creation (wizard-lite: basics → JD via the REAL ai-client → skills/knockouts → submit for approval; prototype's psychometrics/skill-weight sliders simplified to what scoring actually consumes), REQ-03 HR-head approval queue wired to the existing `approval_*` tables (approve/send-back/reject with audit + state transitions — making real the button the prototype left dead). Outcome: requisition lifecycle demoable end-to-end: owner creates → HR head approves → goes live → apply page.
**Wave B — the interview loop (panel persona).** INT-01 schema (`interview_plans`, `interviews`, `interview_feedback` — modelled on the prototype's Supabase migrations, ONE recommendation vocabulary: `strong_yes|yes|hold|no`), INT-02 scheduling (recruiter schedules rounds w/ panel members + candidate signed-link confirm; meeting URL field, no calendar sync), INT-03 panel surface (my interviews, candidate brief, scorecard), INT-04 feedback → stage transitions + recruiter visibility. Live monitor/AI signals: NOT built (facade).
**Wave C — candidate accounts.** CAND-01 auth (Supabase email+password, `candidate` identity tier mirroring the partner_users pattern) + dashboard (stage stepper, interviews list), CAND-02 candidate document upload (reuses ONBOARD-05 storage + verification) + in-portal offer view/accept (reuses signed-link semantics, authenticated).
**Wave D — polish batch** (drawer AI-score hero, internal middleware fix, admin users list, notifications bell if time) → then demo-script rewrite v3 → offboarding resumes post-August unless the window allows.

## 4. Deliberately not building from the prototype
Live interview monitor + AI signals/transcripts (pure theatre), psychometric question bank (nothing consumes it), market intelligence / feasibility AI (static strings), WhatsApp stack, branding/theming admin, phone-OTP auth (email/password matches the platform), bias-rule CRUD (post-POC with real fairness reporting), the prototype's `hr_cases` parallel entity (HireOps' application + onboarding case already cover it — do NOT introduce a third case object).

## 5. Semantic standardisations (where the prototype disagrees with itself)
- Interview recommendation: **`strong_yes | yes | hold | no`** everywhere.
- Application stages: keep HireOps' existing `application_stage` enum; map prototype's interview_1/2 to rounds on `interviews`, not stages.
- Scorecard: one rubric (5 criteria, 1–5) parameterised per round template — not three different point-splits.
- One requisition status vocabulary: extend HireOps' existing `requisition_state_transitions` semantics; do not import the prototype's second/third vocabularies.
