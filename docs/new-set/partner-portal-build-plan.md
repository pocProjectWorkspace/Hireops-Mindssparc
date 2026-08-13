# Partner portal — gap audit & build plan

Date: 2026-08-13 · Audited: `apps/partner-portal`, partner surface of `apps/api`, `packages/db` partner schema, vs promised scope in `docs/partner-wireflows.md`, `docs/partner-data-model.md`, `docs/requirements.md` §6.

Verdict: what shipped in July (PARTNER-01/02) is a thin but solid demo slice — auth tier, dashboard, single-candidate submission with race-guarded dedup/ownership. **Roughly 80% of the documented partner scope is unbuilt**, and — more importantly — the built slice is **not operable in production**: there is no way for internal staff to create a partner, invite a partner user, or assign a requisition except the demo seed script, and the ownership-claim expiry sweep that the schema declares load-bearing does not exist.

---

## 1. What actually works today (verified in code)

- **Portal app** (`apps/partner-portal`, port 3005, Vercel CLI-deployed, not git-connected): exactly 3 routes.
  - `/` dashboard — 4 KPI tiles (`partnerGetDashboardStats`), assigned-req cards (`partnerListAssignedRequisitions`), flat submissions list (`partnerListMySubmissions`).
  - `/submit` — real 533-line wizard: CV upload (PDF/DOCX ≤10MB) → parse pre-fill → consent/ownership attestation → `partnerSubmitCandidate` with three honest outcome cards (`created` / `duplicate_blocked` / `added_to_existing`).
  - `/login` — Supabase email+password only. `/logout` route handler. Messages/Commercials are non-interactive "Soon" badges (good — nothing fake).
- **Auth tier**: `partnerProcedure` (`apps/api/src/trpc/trpc-core.ts:139–205`) — service-role lookup `partner_users ⋈ tenants ⋈ partner_orgs`, synthesises claims, opens RLS context. Documented convention: partner tables only have tenant-isolation RLS, so **every partner procedure must add an explicit `partnerOrgId` predicate** — all 5 existing ones comply.
- **Ownership/dedup** (`partnerSubmitCandidate`, router.ts:14555–14850): assignment-is-authorization → person match on email/phone → active-claim check → create (claim + 90d expiry) / add-to-existing / duplicate-blocked (other partner never named). Race-guarded by partial unique index `uniq_active_claim_per_person`. Every rejection audited to `candidate_dedup_attempts`.
- **Backend tests**: `partner-auth.test.ts`, `partner-submission.test.ts`, `db-partner-a.test.ts` (12 DB-invariant tests). Portal itself has **zero tests** (empty `test/` dir).

## 2. The gaps, ranked by severity

### 2.1 Blocking — the feature cannot be operated
1. **No internal-staff partner management whatsoever.** Zero internal procedures, zero internal-portal pages. Partner orgs/users/assignments exist only via `seed-partner-demo.ts`. Empanelment, invitation, and req-assignment flows (`partner-wireflows.md` §5.1) are NOT STARTED.
2. **No invitation/acceptance flow.** `partner_invitations` table is fully dormant (schema + RLS tests only) — no token minting, no accept route, no way to onboard a real partner user.
3. **Ownership expiry sweep missing — a latent bug.** `candidate-ownership-claims.ts:28-35` states a background sweep flipping `active`→`expired` is load-bearing (Postgres can't put `now()` in the partial-index predicate). No such worker job exists, so **an expired claim blocks resubmission of that candidate forever** (`db-partner-a.test.ts:328` confirms the blocking). Claim release and supersede are also unreachable — columns exist, nothing writes them.

### 2.2 Serious — the loop is half-closed
4. **Partner attribution is written but never read.** `applications.source_partner_id / submitted_by_partner_user_id / partner_submission_metadata` are populated on every partner submission and consumed by nothing; the promised FKs were never added; recruiters see only a generic source chip. No internal partner-attributed queue, no dispute/adjudication surface (`candidate_dedup_attempts` is write-only).
5. **Zero partner emails.** No invitation, no submission acknowledgement, no stage-change notification, no claim-expiry warning (`partner-wireflows.md` §6.1 promises 13 events). The submission path sends nothing.
6. **Claim-window contradiction.** Code hardcodes 90 days (`router.ts:2881`); schema comments say 6 months; router comment points at `partner_msa.exclusivity_window_days` as the real source — and `partner_msa` does not exist.

### 2.3 Wave-1 UX promised but missing
7. No requisition list page or req detail (JD, comp band, knockout questions) — assigned reqs are only dashboard cards; "Reqs" isn't even in the nav.
8. No submission detail page (stage timeline, ownership lock + expiry banner, CV/consent download), no pagination (the API's `capped` flag is ignored), no filters. Stale copy: dashboard empty-state still says "Candidate submission ships next."
9. Auth hardening: no password reset, no magic link, no MFA, no lockout, no 90-day inactivity suspend (all promised in wireflows §3.1). No partner team management (org_admin inviting own recruiters).

### 2.4 Wave-2+ (documented, entirely unbuilt)
Commercials/MSA/fees (`partner_msa`, `partner_fees` tables don't exist), messaging + LLM content scanner (`partner_candidate_messages` dormant), bulk submission, talent-pool/speculative submissions, SLA/quality scorecards, ad-hoc email intake (`ad_hoc_partner_domains` dormant — this is a whole inbound-email subsystem), partner activity log, dispute-resolution UI, invoicing/AP.

### 2.5 Deployment/quality landmines
- `next.config.mjs` hard-defaults the API URL to `http://localhost:3001/trpc` at build time if `NEXT_PUBLIC_API_BASE_URL` is unset — a production build without the env var silently breaks the submit mutation.
- The Vercel project is CLI-deployed, not git-connected (see the 3-gotcha redeploy incantation in the demo-fix notes).
- `assignment_status='paused'` enum value produced/consumed by nothing; `partner_tier` enum is display-only (T5.3 from the 27 Jul handoff, never done).

---

## 3. Build plan

Ordering principle: first make the July slice **operable and correct** (P0), then finish the Wave-1 partner experience (P1), then the commercials schema (P2 — deliberately placed before the Reports module, because `partner_msa`/`partner_fees` is the exact schema that unblocks reports #7 partner scorecard and #8 cost-per-hire in `docs/new-set/reporting-notetaker-build-plan.md`). Wave-2 features stay gated (P3).

House rules: next migration **0113**, internal surfaces on `PageContainer`, query/logic in `apps/api/src/lib/*` not inline in router.ts, one gated ticket at a time.

### Phase P0 — Operable & correct (~1.5–2 wks) — commit
- **P0.1 Internal partner administration.** New internal surface `/partners` (admin + hr_ops gated): list partner orgs, empanel (create org, tier, contacts), invite partner users (mint `partner_invitations` token + email), assign/pause/end req assignments. New internal procedures (`createPartnerOrg`, `invitePartnerUser`, `listPartnerOrgs`, `getPartnerOrg`, `setPartnerAssignment`…). This replaces the seed script as the only creation path.
- **P0.2 Invitation acceptance.** Partner-portal `/accept-invite/[token]` route: token validation (hash, 24h expiry), Supabase account creation, `partner_users` row, attestations checkboxes per wireflows §3.1 (MFA deferred — see §4). Signed-link pattern from `routes/interviews.ts`.
- **P0.3 Claim lifecycle.** Worker job `ownership_claim_sweep` (clone `ai-budget-scan` shape): flip past-expiry claims to `expired`. Internal `releaseOwnershipClaim` procedure (writes `released_at/reason`) surfaced on the P0.1 partner org page. Fix the stale dashboard copy.
- **P0.4 Partner notifications.** Email templates: partner invitation, submission received, stage change on partner-owned application, claim-expiry warning. All through the existing `notification_outbox` + Resend path with `dedupKey`s.
- **P0.5 Recruiter-side attribution.** Migration 0113: add the deferred FKs on `applications.source_partner_id`/`submitted_by_partner_user_id`. Partner chip (org name) on triage/candidate drawer; simple partner-submissions filter for recruiters. The write-only `candidate_dedup_attempts` gets a read surface on the internal partner org page (dispute triage, per the router.ts:3829 TODO).
- **P0.6 Hardening.** Fail the build if `NEXT_PUBLIC_API_BASE_URL` is unset in production; git-connect the Vercel project; first portal smoke tests + extend api gate suites for the new procedures.

### Phase P1 — Wave-1 UX completion (~1–1.5 wks) — commit
- **P1.1** `/reqs` list + `/reqs/[id]` detail (full JD, comp band, knockout questions from `requisition_knockouts`, HM identity hidden), "Reqs" in nav, deep-link to submit.
- **P1.2** `/submissions` + `/submissions/[id]` detail: stage timeline (stage + date only, no internal feedback), ownership lock + expiry banner, CV + consent download; pagination honouring `capped`; filters.
- **P1.3** Dashboard depth: needs-attention feed (new reqs, stale submissions, offer-stage), org_admin aggregate vs recruiter own-only scoping; org_admin team management (invite/suspend own recruiters — reuses P0.2 machinery).
- **P1.4** Password reset (Supabase built-in flow). Magic link / MFA / lockout — decision, see §4.

### Phase P2 — Commercials foundation (~1 wk) — recommend commit (unblocks Reports #7/#8)
- **P2.1** Migration: `partner_msa` (fee structure %, exclusivity window + scope, holdback %, replacement-guarantee days, effective dates) + `partner_fees` (per-hire fee rows, `msa_snapshot` frozen at hire, holdback release date). Wire claim window to `partner_msa.exclusivity_window_days` (falls back to 90). MSA fields on the internal empanelment form (P0.1).
- **P2.2** Read-only commercials tab in the partner portal (org_admin only): eligible fees per hire, holdback release dates. Invoicing/AP/disputes stay out of POC scope per `requirements.md` §11.

### Phase P3 — Wave-2 features — gated on sponsor ask, in likely order of demo value
1. Partner SLA/quality scorecard (partner sees own; internal comparative panel) — mostly reporting queries once P2 exists; folds into the Reports module.
2. Partner ↔ candidate messaging with LLM content scanner — the scanner is a textbook `AI_FEATURE_KEYS` feature (`partner_message_scan`); `partner_candidate_messages` table is ready.
3. Bulk submission (5–50, ZIP/CSV) and talent-pool/speculative submissions.
4. Ad-hoc email intake (`cvs-{req}@…` aliases) — a full inbound-email subsystem (Resend inbound webhook, parser, quotas); the biggest P3 item, recommend keeping deferred.

---

## 4. Decisions needed before dispatch

1. **Demo target:** is there a partner beat in the next client conversation (demo-scope-v3 had one for 24–30 Aug)? If yes, P0 must land first — it's what makes the story "real" rather than seeded.
2. **Auth hardening level:** wireflows promise mandatory MFA + magic link + lockout. Recommend POC = password + reset only (P1.4), MFA as a stated roadmap item — but that softens the security pitch; your call.
3. **Claim window:** confirm 90 days as the default (and MSA-overridable from P2), or align to the 6-month schema comments.
4. **Internal surface placement + roles:** `/partners` gated to `admin` + `hr_ops`? Or a dedicated role?
5. **Ad-hoc email intake:** confirm it stays deferred (recommended) so P3 effort goes to scorecard + messaging.

## 5. Sequencing with the other plans

Partner P0–P2 → **Reports module** (`reporting-notetaker-build-plan.md`) — by then `partner_msa`/`partner_fees` exist, so reports #7/#8 upgrade from "blocked" to "existing data" → **Notetaker**. Partner P3 scorecard work merges into the Reports phase naturally.
