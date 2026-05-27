# HireOps — 13-Week Build Plan to Kyndryl Demo

**Status:** Internal canonical build plan. Drives sequencing of every Claude
Code prompt and every CP work session from now to late August 2026.

**Target demo:** Week of August 24-30, 2026 (week 13 from 2026-05-28).
Fallback target: mid-September 2026 (weeks 14-15) if any major workstream
slips.

**Builder:** CP solo. Rajesh and Lakshmi on client-facing work, not build.

**Last updated:** 2026-05-28

---

## 1. What ships in 13 weeks

Demo-credible delivery of:

- **Working core (already shipped — Phase 1 + Phase 2 + CRS-01 + AI-03):**
  apply → parse → AI-score → triage → offer → simulated Workday hire
- **Wedge proof-of-pattern (new build):**
  - Admin agent surface — workflow CRUD, trigger config, action config,
    approval rules, run history, audit, cost dashboard
  - Interview scheduling agent — Google + Microsoft calendar OAuth, panel
    availability, candidate self-scheduling, reschedule, reminders
  - Follow-ups agent — stale-stage triggers, draft generation, approval
    queue, send via outbox
  - Tickets agent (one sub-surface for demo): candidate Q&A — drafted
    answers from JD + tenant policy, recruiter approves and sends
- **Production-readiness:**
  - Staging deployment on real domain
  - Resend email provider live with verified DKIM/SPF/DMARC
  - `pii_access_log` for DPDPA compliance
  - Privacy page (credible-stub, legal-grade comes later)
  - Empty `export {}` apps deleted from monorepo
  - Nav/link audit — no clickable element 404s
  - Momentum Feed NULL ai_score pill
- **Prototype hygiene:**
  - Lovable prototype rewritten to align with build direction
  - Tiles dropped or labelled "Coming Soon" per
    `prototype-rewrite-plan.md`

Deferred to onboarding window (post-demo):

- Reminders agent (extension of follow-ups pattern, easy onboarding work)
- Tickets sub-surfaces (b) internal recruiter tasks and (c) hiring manager
  intake — onboarding scope
- Real Workday SOAP connector (replaces simulator)
- Real e-signature integration
- Approvals enforcement on requisitions + offers
- JD builder with AI generation
- Six-portal architecture (candidate, partner, careers — only internal
  shipped for demo)
- Bias detection rules, theme/branding, users/roles UI, documents/verification

---

## 2. Sequencing principle

Solo build means strict sequencing within each workstream. Across workstreams,
some parallel switching is possible (build wedge in long sessions; production-
readiness fits in shorter sessions or evenings). The plan below assumes ~70%
on wedge build, ~20% on production-readiness, ~10% on prototype hygiene + ad-
hoc fixes. Adjust if reality differs.

**Two contingency rules built in:**

1. **If by end of week 7 the wedge surfaces are tracking behind**, drop the
   tickets agent from the demo scope (becomes onboarding work) and use the
   reclaimed weeks to land scheduling + follow-ups properly. Better two
   wedge surfaces shipped well than three shipped rushed.
2. **If by end of week 10 the demo isn't going to be ready for August
   24-30**, slip to mid-September 2026. Communicate to Rajesh / Lakshmi /
   Kyndryl no later than week 9. Don't surprise anyone in week 12.

---

## 3. Week-by-week plan

### Weeks 1-2 (May 28 – Jun 11): Admin agent surface foundation

**Wedge build:**

- New tables: `workflows`, `workflow_runs`, `workflow_triggers`,
  `workflow_actions`, `agent_approval_rules` (or whatever the design lands
  on — design session in week 1 day 1)
- tRPC procedures for workflow CRUD
- Admin UI: workflow list, create/edit, toggle on/off, run history view
- Approval queue UI for human-in-loop actions (reuses approval_chains
  schema from migrations 0014/0017)
- Audit list view for agent decisions
- Cost-per-feature dashboard (reads ai_usage_logs)

**Production-readiness (parallel):**

- Staging environment chosen and provisioned (Vercel + Fly/Railway likely)
- DNS for `notifications@hireops.com` initiated (SPF/DKIM/DMARC) — DNS
  propagation clock starts week 1
- Empty `export {}` apps deleted from monorepo
- Privacy page credible-stub written

**Milestone:** end of week 2, admin can log in to `/admin/workflows`, see a
list of platform-defined workflows, drill into one, see its triggers /
actions / run history. No wedge agent is built yet — just the surface for
managing them.

### Weeks 3-5 (Jun 12 – Jul 02): Interview scheduling agent

**Wedge build:**

- Calendar OAuth — Google Calendar + Microsoft 365 Graph API
- Per-tenant calendar credential storage (uses integration_credentials)
- Panel definition — who's on the interview panel for which req
- Availability resolution — query all panelist calendars, intersect
- Candidate-facing self-scheduling page (signed link, mobile-first)
- Calendar invite generation — ICS / native calendar events
- Reschedule flow — candidate or recruiter initiated
- Cancellation flow
- Agent surface in admin: scheduling triggers (stage = "schedule
  interview" → propose slots), actions (send candidate link, send panel
  invites, post to recruiter), approval rules (auto-send vs review-first)

**Production-readiness (parallel):**

- Resend email provider live (DNS should be propagated by week 3)
- LocalEmailProvider → ResendEmailProvider swap via env-gated factory
- Email template review pass — application-received, offer-extended,
  candidate-scheduling, interview-confirmed, etc.

**Milestone:** end of week 5, end-to-end live demo possible — candidate
applies, recruiter advances to "schedule interview" stage, agent proposes
3 slots from real panel calendars, candidate picks one via signed link,
calendar invites fly out, everyone gets confirmation emails. This is the
first visible wedge moment.

### Weeks 6-7 (Jul 03 – Jul 16): Follow-ups agent

**Wedge build:**

- Trigger: stale-stage detection ("candidate at stage X for N days
  without activity")
- Trigger configuration UI — recruiter or admin sets N per stage per
  tenant
- Draft generation — Anthropic call with prompt assembled from candidate
  context, JD, stage, tenant tone
- Approval queue integration — proposed follow-ups appear in approval
  queue with original message preview, edit-then-send option
- Send-via-outbox — uses existing notification_outbox + dispatcher
- Audit logging — who approved, what was sent, when

**Production-readiness (parallel):**

- `pii_access_log` table + middleware to populate on every PII read
- DPDPA data retention policy hooks (configurable per-tenant, default
  values for now)
- Nav/link audit — click every nav item, every settings toggle, every
  drawer link, every breadcrumb. Hide or fix anything that 404s or leads
  to blank.

**Milestone:** end of week 7. **Contingency checkpoint.** If wedge build
is tracking, proceed to tickets agent in weeks 8-10. If behind, drop
tickets to onboarding scope and use weeks 8-10 to polish scheduling +
follow-ups and start prototype rewrite.

### Weeks 8-10 (Jul 17 – Aug 06): Tickets agent (candidate Q&A sub-surface)

**Wedge build:**

- Candidate Q&A intake — candidate emails reply to confirmation, or uses
  a "ask a question" form on the apply-result page
- Trigger: candidate question received → agent drafts response from JD +
  tenant FAQ + tenant policy library
- Approval queue integration
- Tenant FAQ + policy library — admin UI to enter common Q&A
  ("salary range," "typical timeline," "remote/onsite policy")
- Send via outbox
- Audit logging

**Production-readiness (parallel):**

- Workday connector kickoff — real SOAP client against Kyndryl's
  Workday sandbox (assuming credentials in hand by week 8; if not,
  remains simulated for demo)
- Momentum Feed NULL ai_score pill (small ticket, 1-2 hours)
- Backup/restore drill on staging

**Milestone:** end of week 10. All three wedge surfaces (scheduling,
follow-ups, tickets) shipped end-to-end. Admin agent surface complete.
Live demo flow tested.

### Weeks 11-12 (Aug 07 – Aug 20): Prototype rewrite + polish + rehearsal

**Wedge build:** none. Bug fixes only.

**Prototype rewrite (CP-driven Lovable session):**

- Drop Greenhouse sync tile
- Drop AI Voice Agent tile (or relabel to "Coming Soon Q4")
- Drop predictive insights / feasibility / market intelligence (mark
  Market Intelligence as "Pilot")
- Reframe Live Interview Monitor → Interview Operations
- Drop six-portal hero claim from landing (we have one portal + apply
  form for demo)
- Drop 24/7 Candidate AI Coach feature claim from hero
- Add or surface: working apply form flow, AI shortlist (already there),
  admin workflows (re-skin with the actual surface we've built),
  approval queue, audit view, cost dashboard
- Add honesty markers: anything aspirational labelled "Coming Soon" /
  "Pilot" / "Disconnected"

**Polish (parallel with prototype):**

- Email template visual review against design system
- Privacy page legal-review-ready stub (still not final, but worth
  another pass)
- Demo seed data review — Kyndryl-aware candidate names, role titles,
  panel members
- One additional seed candidate for live-demo submit slot

**Rehearsal:**

- Solo demo rehearsal week 11 day 5
- Rehearsal with Rajesh and Lakshmi week 12 day 3
- Final solo rehearsal week 12 day 5
- Bug-fix pass after each rehearsal

**Milestone:** end of week 12. Demo is rehearsed, prototype matches build
direction, staging environment is solid.

### Week 13 (Aug 21 – Aug 27): Demo week

- Final environment check Monday morning
- Live demo to Kyndryl whenever scheduled in the week
- Document Kyndryl's questions and reactions immediately after
- Update `post-demo-onboarding.md` with anything they specifically
  flagged

**Milestone:** demo delivered. Move to onboarding mode.

---

## 4. Risk register

### High risk

**Solo builder for 13 weeks at sustained AI-03 pace.** AI-03 was shipped in
~2 days; that pace assumes focused chunks. 13 weeks of similar focus has
fatigue risk. Mitigation: protect at least 1 day off per week from the
plan; treat estimates as 80% confidence, not 50%.

**Calendar OAuth complexity in weeks 3-5.** Google Calendar is well-
documented; Microsoft Graph is also well-documented but consent flows for
enterprise tenants can require admin approval, which slows testing.
Mitigation: start the consent-flow setup in week 1 in parallel with admin
surface work, not week 3.

**Kyndryl asking for something unexpected in week 4-8 that adds scope.**
Rajesh and Lakshmi's discussions could surface a Kyndryl-specific ask.
Mitigation: protect the build scope explicitly with Rajesh / Lakshmi —
anything Kyndryl-specific that isn't in this plan becomes onboarding
scope unless it's a deal-breaker. Don't take on mid-plan additions
silently.

### Medium risk

**Tickets agent (week 8-10) is the contingency drop point.** If wedge is
behind by week 7, this is the cut. Mitigation: the contingency rule is
explicit and decided in advance, not under pressure in week 8.

**Resend DNS propagation taking longer than expected.** DKIM verification
can take 24-72 hours; some DNS providers are slow. Mitigation: start DNS
in week 1 day 1, not week 3.

**Staging deploy is more work than expected.** Vercel + Fly/Railway is the
plan but neither has been provisioned yet. Mitigation: spike in week 1
day 2 to confirm the deploy story works, before committing to the
choice.

### Low risk

**Prototype rewrite in week 11-12 takes longer than expected.** Lovable
edits are usually fast; if it's slower, the rehearsal can move into week
13 day 1-2. Demo doesn't need the prototype rewrite to be done — the
demo is the build, the prototype is supporting material.

**Workday sandbox access from Kyndryl delayed.** Real connector remains
simulated for demo; not blocking. Becomes urgent in onboarding window.

---

## 5. What gets logged where during the build

Standing log discipline so we don't lose state:

- **`HANDOVER.md`** continues as the canonical drift/decision record.
  Realities #91+ continue from there.
- **`open-questions.md`** continues as the active questions tracker.
  Pruning passes every 2-3 weeks.
- **`docs/poc/` documents** are updated when strategy changes, not when
  features ship.
- **Per-ticket execution reports** from Claude Code go in chat for review
  per the existing rhythm — don't accumulate in the repo.
- **Weekly retro** — short note at end of each week: shipped / didn't /
  why. Goes in a new file `docs/poc/build-log.md`. Five lines a week,
  not a journal.

---

## 6. What changes about the working rhythm

Same as before — chat-Claude designs, Claude Code executes, CP reviews
critically before push. The 13-week scope means more sustained work than
the per-ticket rhythm before. Two adjustments:

1. **Design sessions get longer at the start of each workstream.** Week 1
   day 1 is a longer design conversation for the admin agent surface.
   Week 3 day 1 is the same for scheduling. Week 6 day 1 for follow-ups.
   These aren't 30-minute chats; they're 2-3 hours of getting the surface
   right before the first prompt.
2. **Stop-and-ask gates in prompts stay strict.** Per the established
   pattern. If anything, more strict because the build complexity has
   increased.

---

## 7. What happens if the plan is wrong

Plans are wrong. The contingency rules in §2 are the formal escape
valves. Beyond those, the rule is:

- Reshape the plan at the end of each workstream (end of weeks 2, 5, 7,
  10, 12). Not mid-workstream.
- Update this document when the plan changes.
- Tell Rajesh and Lakshmi at each reshape point — they're managing
  Kyndryl's expectations and need to know if anything's moving.

Cross bridges when we get to them. But document the crossing.
