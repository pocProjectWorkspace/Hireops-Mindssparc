# Demo Readiness — logins & the ten features to land

Companion to `docs/new-set/demo-scope-v3.md` (the act-by-act script).
This page is the one-glance sheet for whoever is driving: every login,
and the ten features the narration must land. Current as of 18 July 2026.

## 1. Demo logins

All passwords are **`TestPassword123!`**. All seeded by the five-seed
runbook (`test-users → demo-data → partner-demo → candidate-demo →
offboard-demo`).

| # | Persona | Login | Portal | What they see |
|---|---------|-------|--------|---------------|
| 1 | Hiring manager | `hiringmanager1@kyndryl-poc.test` | hireops-portal.vercel.app | Requisitions, creation wizard (AI JD + bias gate), approval tracker |
| 2 | HR head | `hrhead1@kyndryl-poc.test` | hireops-portal.vercel.app | Req approvals queue, decision panel (approve / send back / reject) |
| 3 | Recruiter | `recruiter1@kyndryl-poc.test` | hireops-portal.vercel.app | Triage (score ring), interview scheduling, offers, agent approvals, onboarding |
| 4 | Panelist | `panel1@kyndryl-poc.test` | hireops-portal.vercel.app | My interviews, candidate brief, scorecard |
| 5 | HR ops | `hr_ops1@kyndryl-poc.test` | hireops-portal.vercel.app | Offboarding (clearance gates, exit, settlement), onboarding |
| 6 | Admin | `admin1@kyndryl-poc.test` | hireops-portal.vercel.app | AI settings, bias lexicon, scoring weights, users & roles, costs, audit, workflows, integrations |
| 7 | Partner | `partner1@talentbridge-partners.test` | **hireops-partner-portal.vercel.app** | TalentBridge dashboard, assigned reqs, submit candidate |
| 8 | Candidate | `priya.subramanian@example.test` | hireops-portal.vercel.app**/candidate/login** | Her offer (accept in-portal), onboarding documents, interviews |

**The demo inbox:** `digitalfuturity@outlook.com` — Resend is in test
mode, so this is the ONLY address that receives real email. Every
candidate email typed live on stage (the Act-2 apply, any new
activation) must use it. Have the inbox open in a tab before starting.

**On-stage roleplay note:** personas 1–6 are one company (Kyndryl POC
tenant); 7 is the external staffing partner; 8 is a candidate mid-
pipeline. Switching logins IS the demo — each login sees only its own
world, which is the multi-tenancy/RLS story told visually.

## 2. The ten features to land (in demo order)

1. **AI JD generation — real, metered, governed.** The hiring manager
   clicks Generate and a real Claude call writes the JD (~10s). Land:
   every AI call in the product appears in Admin → Costs with dollar
   amounts — including the one you just watched.

2. **The JD bias gate.** Type "rockstar ninja" — it highlights live with
   suggested alternatives, and in block mode the submit is refused with
   the term list. Land: the lexicon is tenant-configurable (show the
   admin table), the enforcement is warn/block, and there is deliberately
   NO demographic inference — a strength, not a gap, for EU clients.

3. **The approval spine.** Submit → HR head sees the full requisition
   (JD, skills, bias warnings) and decides. Do the send-back-with-reason
   round trip. Land: every state change writes an audit row; the
   hiring manager sees exactly why it came back.

4. **AI screening with explanations.** The applied candidate is parsed,
   knockout-checked, and scored by real Claude within ~30s; the triage
   drawer shows the score ring with top factors. Land: scoring emphasis
   is admin-configurable (weights), the AI can be switched off per
   feature, and unscored candidates say so honestly.

5. **The interview loop.** Schedule with a real panel, candidate confirms
   by email link, panelist scores on one rubric — prior-round feedback
   shows recommendations but never scores (anti-anchoring, say it) —
   recruiter completes against a full-submission gate and advances the
   stage with the roll-up recorded. Land: human decisions, machine
   bookkeeping.

6. **The agent wedge — AI you can audit.** The follow-ups agent noticed
   a stalled candidate on its own, drafted with Claude, and STOPPED for
   a human. Approve it live; the email sends; the audit page shows the
   whole chain. Land: this is the pattern every future agent
   (scheduling, candidate Q&A) inherits.

7. **The candidate's own portal.** Priya logs in, sees her offer, accepts
   in-portal — and the onboarding case creates itself. She uploads her
   PAN card; the recruiter verifies it; her checklist ticks. Land:
   candidates are first-class users, not email recipients; every
   document access is PII-logged.

8. **Onboarding through Day-0.** Geography-filtered document checklist
   (India vs Philippines sets), buddy/manager assignment, and on
   advancing to Day zero the (simulated, honestly labelled) Workday hire
   fires and the Worker ID lands on the case. Land: the Workday seam is
   built; the real connector is a post-deal work package with their team.

9. **Offboarding with enforced clearance.** The mid-flight departure:
   try to approve the settlement before access revocation — refused. Try
   to close the case before assets are back — refused. Land: exit
   compliance is code, not checklist theatre; the terminate event mirrors
   the hire event.

10. **Partner sourcing with ownership.** The partner submits a candidate;
    dedup fires (90-day ownership, first-valid-submission rule, no
    partner names leaked); the candidate lands in the SAME pipeline,
    partner-attributed. Land: the schema behind fees/commercials already
    exists — the commercial module is roadmap, the guardrails are live.

## 3. Thirty-second pre-flight (before walking in)

1. Groom + five seeds (order above) — done that morning, nothing run since.
2. Both portals hard-refreshed, all eight logins tested once.
3. Outlook inbox tab open. Admin → Costs open in a tab (it sells itself).
4. Bias enforcement = block. Workers green on Railway.
5. If anything live-fire stumbles: every act has a seeded twin — switch
   to it and keep narrating (fallback map in demo-scope-v3 §4).
