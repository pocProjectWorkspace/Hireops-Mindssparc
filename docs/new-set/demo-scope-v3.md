# HireOps — Demo Scope v3 (Kyndryl window, 24–30 Aug 2026)

Supersedes `demo-scope-v2.md` (14 July). v2 was written for a thin-slice +
wedge demo; since then the platform gained the full lifecycle. This script
demos the **finished platform** the client asked for on 14 July: every
persona, requisition through offboarding, with the agent wedge and the
governance layer intact as the differentiators.

**Environment:** https://hireops-portal.vercel.app (internal + candidate),
https://hireops-partner-portal.vercel.app (partner). All logins
`TestPassword123!`. Live staging: Railway api+workers, real Anthropic,
Resend in test mode (delivery ONLY to digitalfuturity@outlook.com — every
candidate email typed on stage must be that address).

---

## 1. Purpose

A full-platform demo that lands four things:

1. **The lifecycle is complete.** Requisition → AI JD → approval → posting
   → apply → AI screening → interviews → offer → onboarding → Day-0
   Workday hire (simulated) → offboarding → terminate (simulated). Every
   step live on staging, no mockups.
2. **Every persona is real.** Hiring manager, HR head, recruiter, panelist,
   HR ops, admin, partner, candidate — eight logins, each seeing only
   their world.
3. **The wedge still differentiates.** The follow-ups agent drafts with
   Claude, waits for a human, sends, and audits — and now sits inside a
   governance layer (AI settings, bias gate, scoring weights, cost ledger)
   that makes "AI you can audit" a configuration screen, not a slogan.
4. **The deferred work is a sales asset.** Real Workday, calendar sync,
   demographic fairness reporting are framed as named post-deal work
   packages requiring the client's own teams — evidence of engineering
   judgment, not gaps.

Success criteria: Kyndryl sees phases 2 and 3 delivered as asked on
14 July; the France/Germany pitch narrative ("multi-tenant, governed,
GDPR-conscious") is demonstrable; the POC-to-contract conversation moves
to commercials.

---

## 2. The demo flow

Five acts, ~35–40 min with questions. Acts 3–5 can each be cut to a
2-minute narration over seeded state if time compresses — every act has a
pre-seeded fallback and no act depends on a previous act's live-fire
having worked.

### Act 1 — A role is born (hiring manager + HR head, ~8 min)

1. Log in `hiringmanager1@kyndryl-poc.test` → Requisitions → New.
2. Basics for a real-sounding role; **Generate JD with AI** (live
   Anthropic, ~10s — narrate the cost ledger while it thinks).
3. Type "rockstar ninja" into a JD section → the **bias scanner
   highlights live** with suggestions. Try to submit → blocked with the
   term list (block mode pre-set for the demo). Fix the language, add
   skills + a knockout, submit.
4. Log in `hrhead1@kyndryl-poc.test` → Req approvals → open it → the
   bias warnings, JD, and skills are all in the decision view →
   **Send back with a reason** → show the hiring manager's banner →
   resubmit → **Approve**.
5. Post it → open the public apply URL it mints. *"That page is live on
   the internet right now."*

### Act 2 — Candidate to offer (recruiter + panel + partner + candidate, ~12 min)

6. Apply on the public page as a candidate — email
   **digitalfuturity@outlook.com** (test-mode inbox). Resume uploads,
   knockouts evaluate, AI scores it (live workers, ~30s).
7. Partner beat: log in `partner1@talentbridge-partners.test` on the
   partner portal → Submit candidate → dedup/ownership fires (90-day
   claim) → *"and that lands in the same pipeline"* → show it in triage,
   partner-attributed.
8. Triage as `recruiter1@…`: the **score ring + top factors** in the
   drawer; schedule Interview round 1 with **panel1 as panelist**; the
   candidate gets the invitation email (show the inbox); click the
   confirm link.
9. Log in `panel1@…` → My interviews → brief (competencies, no prior
   scores — narrate the anti-anchoring choice) → submit a scorecard.
10. Back as recruiter: **Complete** → the decision summary (full scores,
    lead recommendation) → **Advance stage** → draft + extend the offer.
11. Candidate portal beat: log in `priya.subramanian@example.test` (the
    seeded candidate account) → **see her offer → Accept in-portal** →
    *"the onboarding case just created itself."*

### Act 3 — The wedge (agent + approval + audit, ~6 min)

12. Rohan's seeded pending approval: the follow-ups agent noticed a
    stalled candidate, drafted with Claude, and is **waiting for a
    human** in /approvals. Review, edit a line, approve → the email
    sends (inbox beat if time).
13. /admin/workflows → the agent's run history; /admin/audit → the whole
    chain (draft, approval, send) as audit rows. *"Nothing the AI does
    here is invisible or irreversible."*

### Act 4 — Hire to exit (HR ops, ~8 min)

14. Priya's onboarding case (created in Act 2): the geography-filtered
    document checklist → upload a PAN card from the candidate portal →
    verify it as recruiter → the task completes itself.
15. Advance the case to **Day zero** → the Workday hire fires (simulated,
    honestly labelled) → the **Worker ID lands on the case** (~30s,
    refetch). Integration Health shows the sync record.
16. Log in `hr_ops1@…` → Offboarding → the seeded mid-flight departure:
    walk the clearance gating — settlement **cannot be approved** until
    access revocation completes; the case **cannot close** until assets
    are back and settlement is approved. Show the completed case's
    terminate record. *"The same audit discipline at exit as at hire."*

### Act 5 — The governance tour (admin, ~5 min)

17. /admin/ai-settings: models per feature, the kill switches, PII
    masking, the **bias lexicon** (edit a term live), scoring weights
    with the honest "instruction, not arithmetic" copy.
18. /admin/costs: every AI call from this very demo, with today's spend
    in dollars. /admin/users: roles, invite, deactivate.
19. Close on the roadmap slide: post-deal work packages (real Workday
    with their team, calendar sync, fairness reporting pending their
    data-collection policy, SSO) — each with a clean seam already built.

---

## 3. What's deliberately not in the demo

- **Real Workday** — client's own 14 July direction: post-deal work
  package with their team. The simulator is labelled honestly on every
  surface it touches.
- **Real calendar sync** — the scheduling seam (`external_booking_ref`)
  exists; sync with the client's Workspace/Outlook tenant is a named
  work package (same logic as Workday: their IT involved).
- **Demographic fairness dashboards** — we do not collect protected
  attributes and will not without the client's consent flow and legal
  review; the language-level bias gate is what's honest today. This
  framing is a strength in the France/Germany context — say it plainly.
- **Live video interviews / AI interview monitors** — external meeting
  links are the enterprise-correct integration; the prototype's "AI
  signals" theatre was deliberately not built.
- WhatsApp/SMS, job-board posting, reporting suite, search, bulk ops,
  i18n — post-POC roadmap, pre-framed in §5 of the status doc.

## 4. Known live-demo risks and mitigations

### High
- **Live AI calls (JD gen, scoring, agent draft).** Each has a seeded
  fallback: a pre-generated JD on a second draft req, pre-scored
  candidates in triage, Rohan's pending approval. If Anthropic is slow,
  narrate and switch to the seeded artefact.
- **Shared dev/staging DB.** Re-seed before the session (checklist
  below). Do NOT run tests or CI pushes during the demo window.
- **Email delivery.** Only digitalfuturity@outlook.com receives. Have
  the inbox open in a tab beforehand; the dev outbox row is the
  fallback proof if delivery lags.

### Medium
- **Worker timing beats** (score ~30s, Worker ID ~30s): pre-plant a
  narration line for each wait; both have seeded already-done examples
  if a drain is slow.
- **Eight logins.** Use one browser with profiles or two browsers
  pre-authenticated; rehearse the switch order.

### Low
- Vercel/Railway cold starts (hit every surface 10 min before);
  the pino dev-only crash does not exist in production builds.

## 5. Pre-demo checklist (day of)

1. `pnpm db:groom:demo-data --execute`
2. Five seeds in order: `db:seed:test-users` → `db:seed:demo-data` →
   `db:seed:partner-demo` → `db:seed:candidate-demo` →
   `db:seed:offboard-demo`
3. Verify Railway workers healthy (`railway logs --service workers`)
   and both services on current main (`railway deployment list`).
4. Hard-refresh both portals; log every persona in once; open the
   outlook inbox tab.
5. Confirm /admin/ai-settings: bias enforcement = block, defaults
   otherwise; /admin/costs loads.
6. NO test runs, gate runs, or pushes after this point.

## 6. What we want from Kyndryl at end of demo

Unchanged in spirit from v2: contract signature momentum, a named
France/Germany GCC prospect conversation, and agreement that Workday +
calendar integration scope starts as a joint work package post-signature.
