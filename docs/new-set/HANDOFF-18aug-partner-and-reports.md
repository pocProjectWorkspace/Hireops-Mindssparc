# HANDOFF — partner portal (P0–P2) + reporting module (R0–R1)

**Session window:** 12–18 August 2026. **Branch:** `main`. **Head at handoff:** `e338bd7`.
**Pushed through:** `fc00db3` (Phase R0). **Unpushed at handoff:** 5 commits — `5c742f9`, `a024529`, `0b9c6b6`, `deb4dc0`, `e338bd7`.
**Migrations applied to staging (by the human, all verified):** `0113`, `0114`, `0115`.

Two build plans were written and then executed in this window. Both live in `docs/new-set/`:
- `partner-portal-build-plan.md` — the audit + phased plan (P0→P3).
- `reporting-notetaker-build-plan.md` — the assessed version of the client's reporting/notetaker PDF (R0→R3).

Read those for the *why*; this doc is what actually shipped, what's left, and the traps.

---

## 1. Why the partner work happened first

The client PDF asked for reporting + a notetaker. Assessing it against the codebase surfaced a bigger problem: the partner portal was **~80% unbuilt relative to its own documented scope**, and — more importantly — **not operable at all**. Three findings drove the whole phase:

1. **Partners could only exist via a seed script.** No internal surface could empanel an org, invite a partner user, or assign a requisition. `partner_invitations` was a dormant table.
2. **A latent data bug.** `candidate_ownership_claims` declared (in its own schema header) that a background sweep flipping expired claims was load-bearing, because Postgres can't put `now()` in a partial-index predicate. That sweep had never been built — so **an expired claim blocked resubmission of that candidate forever**. A DB test even documented the blocking as expected behaviour.
3. **Attribution written but never read.** Every partner submission stamped `source_partner_id`; nothing displayed it, the promised FKs were missing, and partners received zero email — ever.

Reports #7 (partner scorecard) and #8 (cost-per-hire) were also rated "blocked — no fee schema", which is why partner P2 (commercials) was sequenced *before* the reporting work resumed.

---

## 2. Partner portal — what shipped

### P0 — operable & correct (pushed + deployed 13 Aug)
| Commit | Ticket | What |
|---|---|---|
| `e0fe248` | P0.1A | Internal partner-admin API: 8 procedures gated to admin+hr_ops (`listPartnerOrgs`, `getPartnerOrg`, `createPartnerOrg`, `setPartnerOrgActive`, `invitePartnerUser`, `revokePartnerInvitation`, `assignRequisitionToPartner`, `endPartnerAssignment`) in `apps/api/src/lib/partner-admin.ts` + a `partner-invitation` email template. Invitation tokens: 32 random bytes, **only the sha256 is stored**; the raw accept URL is returned to the caller (staging Resend is test-mode, so the UI must be able to copy the link). |
| `df0c58d` | P0.1B | Internal `/partners` surface (list, empanel form, org detail with users/invitations/assignments, one-time accept-link panel). Also widened **only** `listRequisitionSummaries` to hr_ops so the assign-requisition picker works for both partner-admin roles. |
| `8af6561` | P0.2 | Accept-invite flow: public preview with typed dead states (`invalid`/`expired`/`already_used`/`revoked`; `invalid` leaks nothing), redemption creating the Supabase auth user + `partner_users` row + three attestations, auto sign-in. |
| `73ba398` | P0.3 | **The bug fix.** `ownership_claim_sweep` worker job (15 min, cross-tenant service-role) + `releaseOwnershipClaim` + a Claims section on the org page. Proven by an integration test: the same resubmission is `duplicate_blocked` before the sweep and `created` after. |
| `83205c4` | P0.4 | Three partner emails (submission received, stage changed, claim-expiry warning). Stage emails carry **stage + date + candidate name only** (§6.3); the test asserts a whole-payload key allowlist so adding a field forces the privacy question. Dedup 23505s are absorbed in a savepoint so an already-sent email can't poison the enclosing transaction. |
| `9df39a7` | 0113 | Attribution FKs on `applications` — composite `(tenant_id, id)` refs with **column-targeted** `ON DELETE SET NULL` (a bare SET NULL on a composite FK would null `tenant_id` too). |
| `9fcd58c` | P0.5 | `partnerOrgName` on the triage list + candidate drawer ("Partner · Acme"), dedup-attempts dispute read, and the offer accept/decline paths finally firing the partner stage email (they bypass `transitionApplicationStage`, so the helper was extracted to `lib/partner-stage-email.ts`). |
| `8310f26` | P0.6 | Vercel builds now **fail** without `NEXT_PUBLIC_API_BASE_URL` (the localhost default used to bake into the client bundle); worker dedup detection fixed to match on error **code** (the old substring check never matched, so every expected dedup logged as an error); the portal's first test. |

### P1 — Wave-1 UX (15 Aug, local until pushed)
| Commit | Ticket | What |
|---|---|---|
| `51288c5` | P1.1 | `/reqs` list + detail: full JD, comp band ("Not disclosed" when null), ordered knockout questions, the org's own submission count. Unassigned / other-tenant / nonexistent reqs all raise an **identical** FORBIDDEN so a partner can't probe what exists. |
| `768ea91` | P1.2 | `/submissions` list + detail: ownership banner (expiry date beats the lagging status flag), stage timeline carrying **only** `{toStage, transitionedAt}`, submitted snapshot, no-JS-safe stage filter. |
| `1548069` `7626388` | P1.3 | Org-admin team management (shared invite core with the internal path; suspension proven to lock the teammate out at `partnerProcedure`) + a deterministic needs-attention feed (new reqs, stale submissions, offer-stage, expiring claims). |
| `8d0694d` | P1.4 | Supabase password reset (`/forgot-password`, `/reset-password`, no account enumeration) + partner-side invitation revoke. |

### P2 — commercials (15 Aug, local)
| Commit | What |
|---|---|
| `28c1db3` | Migration 0114: `partner_msa` (one live row per org; terms change = close-and-reopen, never update in place) + `partner_fees` (one accrual per hire, terms frozen in `msa_snapshot`, RESTRICT FKs because fee rows are financial records). |
| `5f56813` | MSA editor on the internal org page, fee accrual hooked into the offer-accept side effects (bigint-only math, best-effort, retry-safe via the per-application unique), the ownership-claim window finally reading the live MSA, and the partner portal's `/commercials` tab (org-admin only) replacing its last "Soon" badge. |

**Partner P3 remains gated** (SLA scorecard for partners, messaging + LLM content scanner, bulk/talent-pool submission, ad-hoc email intake). Ad-hoc email intake is the biggest and is recommended to stay deferred — it's a whole inbound-email subsystem.

---

## 3. Reporting module — what shipped

### Phase R0 — foundation (pushed 16 Aug)
| Commit | Ticket | What |
|---|---|---|
| `4e80344` | R0.1 | **The semantic layer** — `apps/api/src/lib/reports/{dimensions,measures}.ts` + `packages/api-types/src/reports.ts`. `getRecruitmentReport` refactored onto it; numbers proven identical by an old-vs-new differential over live data, not just the referee suite. The reserved `from`/`to` filter finally works. |
| `fd34688` | R0.2 | `/reports` catalog (admin/hr_head/hr_ops) with the shared filter bar, plus requisition aging and recruiter productivity — the two reports the assessment rated genuinely missing. |
| `4cd6349` `d368a21` | R0.3 | Pipeline & speed (pure composition over the measures) + **SLA hot spots** off the tenant's resolved thresholds + admin-only governance cards. |
| `fc00db3` | R0.4 | CSV export (`apps/internal-portal/src/lib/csv.ts`, shared with the audit console) + role-gated drill-downs. |

### Phase R1 — sponsor pack (17–18 Aug, local)
| Commit | Ticket | What |
|---|---|---|
| `5c742f9` | R1.1 | Headcount vs plan (#17) — including the honest "requisitions raised outside any envelope" number — and approval cycle analytics (#18) with **per-step** approver attribution (a decision's clock starts at the previous step's decision, via `LAG` over the chain). |
| `a024529` | R1.3 | Partner/agency scorecard (#7) — the report the assessment called blocked, now fed by P2's fee data. Shortlist rate is **ever-reached** (via transitions), not current stage. |
| `0b9c6b6` | 0115 | `interviews.completed_at` / `cancelled_at`. Status said *what*, never *when*. Backfill is an explicit approximation (completed → `COALESCE(scheduled_end, updated_at)`; cancelled → `updated_at`). |
| `deb4dc0` | R1.2 | Interview & scorecard health (#9) + onboarding readiness (#19), and the API now **stamps** the 0115 timestamps on all three real transition paths (`COALESCE`-guarded so a recorded moment can't move). |
| `e338bd7` | R1.4 | Executive summary / board pack (#23) — composed, never re-derived; the test asserts field-by-field equality against the reports that own each number. Plus a time-to-fill **trend** measure and print styling (the plan's alternative to PDF export). |

**The catalog is now the executive summary + eight detail reports on one shared filter bar.**

---

## 4. Definitions pinned (the semantic contract)

These live in code comments and are enforced by tests. A new session must not "fix" them casually:

- **Funnel** = applications whose *current* stage is X (a snapshot, not "ever reached").
- **Time to fill (point)** = created_at → earliest `offer_accepted` transition, per application; the period windows on **application creation**.
- **Time to fill (trend)** = the same clock, medianed within the **hire** month and windowed on the hire event. The two are *not* expected to reconcile; a test pins a fixture where they legitimately differ.
- **Time in stage** = completed visits only, via `LEAD()` over transitions; terminal stages are never left, so they're null.
- **SLA breach** = an application *currently* sitting in a thresholded stage past the tenant's resolved threshold (jsonb over code defaults). A live snapshot, not a history.
- **Shortlist rate (partner)** = ever-reached shortlisted-or-beyond via transitions — so a hired candidate still counts.
- **Approval turnaround** = per-step; "decided" includes rejected/cancelled (excluding them would flatter the median).
- **Agency cost per hire** = `partner_fees` spend ÷ fee-bearing hires, both on the `hired_at` clock. Blended cost-per-hire is **not** computable — no ad-spend or internal-cost capture exists.
- **`ORDER BY` on a Postgres enum column sorts by declaration order, not alphabetically.** This bit us once (source-mix tiebreak); the behaviour is now pinned by a test and a comment.
- Period filters bound **application creation** unless a report says otherwise; date bounds are whole **UTC** days.

---

## 5. What's left

**Immediately next (the ticket that was in flight at handoff):**
- **R1.5a — scheduled digest backend.** Dispatched, stalled before writing anything; **nothing is in the tree**. Design already decided: a `reportDigests` block in `tenants.settings` (resolve-over-defaults like `aiBudget`), a `report-digest` email template carrying the board-pack headline, and a worker job cloned from `ai-budget-scan` at a 30-minute tick. **No new table** — the outbox dedup key `report_digest:<tenant>:<cadence>:<period>` *is* the idempotency mechanism, so a missed tick self-heals. Generate with `isAdmin: false` so AI-spend never reaches arbitrary recipients. One thing to verify first: the report libs are typed against the api's tenant-bound drizzle handle; the worker has service-role `poolDb`. Check assignability and widen the param type minimally if needed — every report lib carries explicit `tenant_id` predicates, which is exactly what makes a service-role call safe.
- **R1.5b — the small admin UI** for cadence + recipients.

**Gated on a human decision:**
- **Diversity funnel (#13) + AI fairness monitor (#14).** There are **zero** demographic fields in the schema. This needs opt-in capture, purpose-scoped consent, k-anonymity thresholding and legal sign-off (DPDPA vs EEOC framing differ). The board pack already carries a typed `{available: false}` placeholder so the wire contract is ready.
- **Notetaker (reporting plan Phase R2/R3).** Heavier than the PDF implies: there are **no inbound webhook endpoints anywhere** in the codebase, storage has no signed-URL support (needed for audio), and consent is a one-shot apply-time checkbox that would need a per-interview, purpose-scoped model. What *does* transfer: the `ai-score-drain` outbox pattern for async transcript processing and the whole `AI_FEATURE_KEYS` config/cost/provenance layer.
- **Quality of hire / early attrition (#12)** — needs the HRMS post-hire write-back loop (the deferred Workday work package).

**Known follow-ups (small, unblocked):**
- Re-home `/admin/reports` and the four persona surfaces (`/metrics`, `/insights`, `/hr-analytics`, `/exec-audit`) onto the semantic layer — they still hand-roll their own SQL. `timeInStageAvgs` and `offerFunnel` already carry `getHrMetrics`' exact definitions so it can migrate with zero number movement.
- Per-report role gating (one `REPORTS_READ_ROLES` set covers the catalog today).
- No `?recruiter=` filter exists on any surface, so the productivity report has no drill-down.
- Fee status lifecycle (`accrued → payable → paid`) has **no writer** — Wave-3 invoicing; a holdback-release sweep worker is the natural shape.
- `markInterviewNoShow` isn't stamped (0115 added no `no_show_at`).
- Onboarding readiness' document denominator counts uploads, not the geography's *required* set.
- Partner-portal Vercel project is still CLI-deployed, not git-connected.

---

## 6. Traps and operational realities

- **Executor stalls.** Roughly a dozen Opus-executor runs died mid-stream in this window (infra stream errors / 600s watchdog), almost always at the test-file step. Recovery that works: re-dispatch a **continuation ticket that states the exact tree state**, or finish the remainder in-session. Nothing was ever lost — partial work survives in the working tree.
- **Run report test suites ONE FILE AT A TIME.** Combined runs hit Supabase pooler contention and produce timeouts that look exactly like regressions. Two interview suites failed together and passed individually.
- **Stray vitest processes starve the pool.** Before believing any test failure: `pgrep -f vitest`, check elapsed time, kill strays.
- **The classifier blocks the orchestrator from running `pnpm db:migrate` and `git push`.** Both are handed to the human as `!` commands. Migrations are authored + verified by the agent, applied by the human.
- **`gh` has three GitHub accounts on this machine.** A push 403 "denied to teammindssparc" means the active account drifted; fix with `gh auth switch -u pocProjectWorkspace`.
- **Port 3003 is often held by an unrelated Forge project.** Smoke on an alternate port; don't kill it. Dev smokes need `WATCHPACK_POLLING=true` or the watcher EMFILEs and routes 404 spuriously.
- **Tests write to the shared staging DB.** Every suite uses a dated synthetic namespace to stay isolated (a02–a21 partner/reports; report suites use historical years 2011–2018). Re-seed before demos.
- **Prettier drift breaks CI.** Run `prettier --check` **last**, after all edits, and re-run lint/tsc/tests on anything it rewrites.
- **Resend is in test mode** — partner and candidate emails only deliver to the owner inbox. For the partner demo beat, use that address as the invitee.

**Demo prep specific to this work:** no seeded partner org has an MSA, so the Commercials tab shows its honest empty state until terms are agreed in the internal UI. That's a good demo beat in itself: agree terms → have the partner's candidate accept an offer → the fee appears with frozen terms and a holdback date.
