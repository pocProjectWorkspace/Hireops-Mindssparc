# Configurability sweep — pre-pilot audit (Solenis)

**Date:** 25 Aug 2026 · **Sweep run on:** `feat/ai-interview-n4` (= `main` + the N4 AI-interview
commits, so the newest consent/retention/AI-interview code is included) · **Read-only audit; no
application code changed.**

Every `file:line` below was verified in code during this sweep unless explicitly marked
*(inferred)*. Effort sizes and "who would want it changed" are judgement, not code facts.

The yardstick throughout: a feature is **properly configurable** only with all four of
(1) a code default, (2) a resolver that merges `tenants.settings` over it and never throws
(the `resolveSlaThresholds` discipline, `packages/sla-thresholds/src/index.ts:82`),
(3) an admin surface, (4) an audit trail.

---

## 1. Executive summary

| Category | Count |
|---|---|
| A — hard-coded, should be tenant-configurable | 10 |
| B — correctly hard-coded, must stay fixed (governance positions) | 10 |
| C — feature exists, no config surface at all | 3 |
| D — config in `tenants.settings`, no admin UI | 1 |
| E — stale comments claiming things are hard-coded that aren't | 5 |

The platform's configurability story is **stronger than its comments say**. Twelve
`tenants.settings` blocks are already properly configurable end-to-end (aiSettings, biasLexicon,
scoringWeights, systemSetup, shortlistDefaults, aiBudget, reportDigests, slaThresholds,
governancePolicy, retentionPolicy, irisPolicy, branding — router.ts:9366–9912, 2360, 10274),
served by ~24 admin surfaces under `apps/internal-portal/src/app/admin/`. Three separate comments
still claim SLA hours are hard-coded; they are not (category E).

**The five findings most likely to become Solenis change requests during the pilot:**

1. **Market-intelligence source note renders `rows[0]`'s note as the banner for the whole table**
   (`MarketIntelligenceView.tsx:70`). Market intel is the feature Solenis is buying this platform
   for; the moment two rows carry different notes the banner is wrong. Effort S.
2. **Interview audio retention is a constant — 30 days + 90-day ceiling**
   (`interview-media-purge.ts:47,68`). `/admin/retention-policy` covers *documents* only. Solenis's
   DPO (GDPR exposure via the European parent) will ask to set this number. Effort M.
3. **Partner claim-window fallback is 90 days in code while the schema comment says six months**
   (`router.ts:3242` vs `candidate-ownership-claims.ts:21`). Orgs *with* an MSA already get a
   per-org window; the no-MSA default is the gap, and commercials teams notice numbers like this.
   Effort S.
4. **The "SLA imminent" alert window is fixed at 4 hours** (`sla-imminent-scan.ts:47`) even though
   the thresholds it alerts against are per-tenant. First thing a tenant tunes after tuning
   thresholds. Effort S.
5. **Blind-screening mask scope is fixed** — reveal stage `tech_interview`, subject role
   `recruiter`, see-through `admin`/`hr_head` (`governance.ts:102–113`). The code comment itself
   says the narrow scope is "easily widened later". Needs a product decision before building.
   Effort M.

Currency (INR assumed throughout the comp engine) is deliberately **not** in this top five:
Solenis's pilot is India-only hiring, so it holds until the France/Germany GCC phase (A7).

---

## 2. Category A — hard-coded, should be tenant-configurable

| # | Finding | Where | Current value | Who wants it changed | Effort | Migration? |
|---|---|---|---|---|---|---|
| A1 | Market-intel banner note is `rows[0]`'s per-row note (with a hard-coded fallback), presented as if it described the whole table | `apps/internal-portal/src/components/market/MarketIntelligenceView.tsx:70,224`; seeded one string per row in `packages/db/src/scripts/seed-benchmarks.ts:51` | `"Curated benchmark, update quarterly"` | HR head / admin — market intel is the killer feature | **S** — either show notes per row, or add a tenant-level `marketIntelNote` to `tenants.settings` + resolver + field on an admin surface | No |
| A2 | Interview audio retention days | `apps/workers/src/jobs/interview-media-purge.ts:47` (`INTERVIEW_MEDIA_RETENTION_DAYS = 30`) | 30 days from interview completion | Solenis DPO / legal | **M** — extend the existing `retentionPolicy` block (`packages/api-types/src/retention-policy.ts`) with an `interviewAudioDays` field, resolver default 30, purge sweep reads per-tenant, extend `/admin/retention-policy`. Keep the 90-day ceiling as the platform cap on the override (see B9) | No (jsonb) |
| A3 | Partner claim-window fallback for orgs without an MSA | `apps/api/src/trpc/router.ts:3242` (`PARTNER_CLAIM_WINDOW_DAYS = 90`), applied at `router.ts:16097` | 90 days | Whoever owns partner commercials at the tenant | **S** — a `partnerDefaults.claimWindowDays` settings key + resolver + one field on the partner admin surface. Fix the schema comment at the same time (E5) | No |
| A4 | SLA-imminent alert window | `apps/workers/src/jobs/sla-imminent-scan.ts:47` (`IMMINENT_WINDOW_HOURS = 4`) | 4 hours before breach | Recruiting ops — alert-fatigue tuning | **S** — belongs in the `systemSetup` block, which already owns "who gets alerted" (`router.ts:9366–9389`) | No |
| A5 | Blind-screening mask parameters: reveal stage, subject role, see-through roles | `packages/api-types/src/governance.ts:102` (`CANDIDATE_MASK_STAGE_GATE = "tech_interview"`), `:112` (`MASK_SEE_THROUGH_ROLES = ["admin","hr_head"]`), `:113` (`MASK_SUBJECT_ROLE = "recruiter"`) | Fixed scope; always on for recruiters, no surface anywhere | HR head — widen to hiring managers, or shift the reveal stage | **M** — a masking sub-block in `governancePolicy` + resolver + `/admin/governance-policy` fields. Recommend the *scope* becomes configurable but a full off-switch stays a deliberate decision (see B/open questions) | No |
| A6 | Comp verdict rule parameters (≤ mid → proceed; ≤ max → negotiate at the mid/ask midpoint; > max → needs approval) | `apps/api/src/lib/comp-rules.ts:79–107` | Band-midpoint/ceiling boundaries, midway-split suggestion | HR ops — e.g. a 10 %-over-ceiling tolerance before approval | **M** — parameters into a `governancePolicy` sibling block; the engine stays deterministic (the selling point, see B), only its knobs move | No |
| A7 | Currency + locale: INR/paise/lakh assumed through the comp engine, band formatting, analytics and partner fees | `apps/api/src/lib/comp-rules.ts:12,61–64`; `router.ts:2885–2900` (INR-only ₹ en-IN formatting), `:25913–25921` (non-INR bands excluded from a conversion, "INR here always"), `:28558–28564`; fallbacks `"INR"` in `req-feasibility.ts:118`, `partner-commercials.ts:369,405` | INR everywhere; non-INR degrades or is excluded | Phase-2 France/Germany GCC tenants — **not** the India-only pilot | **L** (1 wk+) — multi-currency across comp desk, formatting, analytics, partner fees | Likely (currency columns exist in places, but cross-currency analytics needs schema thought) |
| A8 | AI-interview link expiry default | `apps/api/src/lib/ai-interview-session.ts:269` (`AI_INTERVIEW_DEFAULT_EXPIRY_DAYS = 7`; recruiter can set 1–30 per invite, `:706–709`) | 7 days default | Recruiting ops wanting a house default ≠ 7 | **S** — tenant default inside the clamp; bounds stay platform-fixed | No |
| A9 | AI-interview question count bounds | `packages/api-types/src/ai-interview.ts:62–63` (min 5, max 10) | 5–10, derived per round | Tenants with longer/shorter async-round culture | **S** — tenant range within a platform cap (candidate-experience guardrail stays) | No |
| A10 | Email sender identity is one env var for the whole deployment | `packages/notifications/src/factory.ts:18` (`EMAIL_FROM`), `resend.ts:26–27` | Single global From for every tenant | Tenant branding — mail "from Solenis", not from the platform | **M** — per-tenant From in `branding` settings is small in code; the real cost is per-tenant verified sending domains in Resend (ops) | No |

Not listed as gaps because they are already configurable (spot-checked this sweep): email
template copy is per-tenant via slot overrides (`packages/email-templates/src/slots.ts`);
stage-stale day thresholds come from each agent's `trigger_config`
(`apps/workers/src/jobs/stage-stale-scan.ts:76`); AI budget thresholds from
`tenants.settings.aiBudget` (`ai-budget-scan.ts:22`); offer expiry is per-offer recruiter input,
1–60 days (`procedures.ts:1016`, `router.ts:6578`).

---

## 3. Category B — correctly hard-coded: the deliberate governance positions

This list is a **selling point, not a backlog**. These are the answers to an enterprise
governance review: what a tenant — including Solenis, with GDPR and EU AI Act exposure through
their European parent — is deliberately *not* allowed to switch off.

1. **The no-score / no-rating stance on interviews.** AI interview notes "never score, never
   rate, never produce or pre-fill a hire/no-hire recommendation"
   (`packages/api-types/src/ai-settings.ts`, `interview_notes` meta; enforced in the prompt,
   `apps/workers/src/lib/interview-notes-prompt.ts:237`). The AI first round writes questions,
   never ideal answers, and a question set naming a rubric criterion the round doesn't have is
   *discarded* (`apps/api/src/lib/ai-interview-questions.ts:272`). **Why fixed:** letting a
   tenant flip interviews into automated assessment changes the product's regulatory class under
   the EU AI Act's high-risk employment provisions and GDPR Art. 22. Humans judge; that is the
   architecture, not a preference. (Applicant *screening* scoring exists separately, is
   per-tenant switchable, and never auto-rejects.)
2. **Consent is required, never assumed.** "ABSENCE IS NOT PERMISSION"
   (`apps/api/src/lib/interview-recording-consent.ts:15`); consent is withdrawable at any time
   and the log is **append-only** (migration 0116, `interview-recording-consent.ts:4–5,102`).
   **Why fixed:** a tenant-configurable consent model (opt-out, implied consent) would
   invalidate the lawful basis the whole recording pipeline stands on, and a mutable log cannot
   answer an audit.
3. **Disclosure copy is version-stamped and platform-owned.** `RECORDING_CONSENT_VERSION`
   (`interview-recording-consent.ts:73`) and `AI_INTERVIEW_DISCLOSURE_VERSION`
   (`ai-interview-session.ts:181`) must bump with any wording change — stored consent rows
   reference the version they were captured under. Both disclosures carry a structural
   `legalReviewRequired: true` (`ai-interview-session.ts:198`) because current copy is
   placeholder pending legal review. **Why fixed for now:** tenant-supplied wording breaks the
   "what exactly did this candidate agree to?" guarantee unless per-tenant version *and text*
   are stored per consent row. That is a designable future feature, not a settings key — see
   open question 3.
4. **AI prompt text and the 16 `*_PROMPT_VERSION` constants** (e.g.
   `packages/ai-scoring/src/prompt.ts:24`, `apps/api/src/lib/interview-prep.ts:24`, full list
   grepped across `apps/api/src/lib/*`, `apps/workers/src/lib/*`). **Why fixed:** the prompts
   *are* the grounding guarantees — "never demographic inference", "never invented market
   claims", "never scores" (see every `AI_FEATURE_META` description). A tenant-editable prompt
   could silently remove a safety property while the platform still stamps its version on the
   output. Tenants influence AI behaviour through structured inputs they own — benchmarks,
   rubrics, JDs, the bias lexicon — never through prompt text.
5. **The model allowlist** (`packages/api-types/src/ai-settings.ts:42`) contains only models
   with a pricing row, by the file's own stated reasoning: "offering models we can't attribute
   cost for would make this surface lie." Cost honesty over model choice.
6. **Compliance weights must sum to 100** (`packages/api-types/src/governance.ts`, the
   `.refine` on `governancePolicySchema`). The weights are tenant-configurable; the constraint
   that keeps the score meaningful is not.
7. **Terminal application stages can never carry an SLA** — the resolver ignores overrides for
   them by construction (`packages/sla-thresholds/src/index.ts:82` onwards, "terminal stages
   are never overridable").
8. **Worker cadences** (`apps/workers/src/index.ts:36–56`: 5 s drains, 60 s scheduler, daily
   purge). Infrastructure timing, not tenant-visible behaviour; per-tenant intervals would
   multiply load and change nothing a tenant can observe.
9. **The 90-day audio hard ceiling** (`interview-media-purge.ts:68`) is the backstop for rounds
   that never reach a terminal state — without it, "we keep audio for 30 days" is false for
   exactly the rounds nobody is watching (the file's own words, `index.ts:109–114`). If A2
   ships, the tenant sets days *under* this ceiling; the ceiling itself stays the platform's
   promise.
10. **The role vocabulary** — eight fixed internal roles
    (`packages/api-types/src/procedures.ts:2669`, mirrored by pgEnum). Every permission check
    in the router is keyed to these. Custom roles are a re-architecture, not a setting; for the
    pilot this is a stated platform constant, honestly a "fixed by architecture" rather than a
    governance stance.

---

## 4. Category C — feature exists, no config surface at all

1. **`partner_tier` is display-only.** The enum exists
   (`packages/db/src/schema/partner-tier.ts:10`, `empanelled`/`ad_hoc`), it's settable and
   filterable in the UI (`PartnersClient.tsx:29`), but nothing branches on it — no fee, window,
   or routing consequence found in `apps/` or `packages/` *(absence verified by grep, not
   exhaustive reading)*. Either give tiers behaviour (e.g. tier-default claim windows/fee
   models — pairs naturally with A3) or expect "what does this dropdown do?" in the pilot.
2. **`assignment_status = 'paused'` has no producer.** The enum value exists
   (`packages/db/src/schema/partner-assignment-status.ts:10`) and the UI renders it
   (`PartnerOrgDetailClient.tsx:1216`), but the only status writes found in the router set
   `"active"` (`router.ts:13544,13559`) *(absence verified by grep for `"paused"` across
   `apps/` and `packages/`)*. Dead state, reachable only by DB edit.
3. **Candidate dedup policy is fixed.** Partner-submission dedup matches on normalised
   email/phone with hard-coded decisions (`router.ts:~16050`, `allow_new` /
   `reclaimed_no_active_claim`; normalised columns at `router.ts:4197–4198`). Reasonable
   defaults, but there is no surface to see or tune the policy, and dedup disputes are a
   classic partner-management escalation.

---

## 5. Category D — settings exist, no admin UI (DB-edit only)

1. **`tenants.settings.ai_provider`.** Read by the ai-client factory with default `anthropic`
   (`packages/ai-client/src/factory.ts:114`); every settings mutation deliberately preserves it
   verbatim (`router.ts:10274,10662` — "preserving every OTHER key (ai_provider, cosmetic
   config)"), and no mutation writes it. Today it changes only via direct DB edit. This may be
   *intentional* — provider choice affects cost attribution (see B5) and BYO keys come from the
   per-tenant credential store (`factory.ts:71–72`), so an ops-only knob is defensible. If so,
   say that in a comment; if not, a UI field is S. Every other settings block found in the
   router has an admin UI (shortlist defaults are edited from the recruiter's shortlist view
   rather than `/admin` — `ShortlistView.tsx:134` — which is a placement choice, not a gap;
   flagged in open question 4).

---

## 6. Category E — stale comments (verified against code before reporting)

All three SLA claims below are false since T4.1 shipped `resolveSlaThresholds`
(`packages/sla-thresholds/src/index.ts:82`), the `/admin/sla-thresholds` surface
(`apps/internal-portal/src/app/admin/sla-thresholds/SlaThresholdsClient.tsx`), the
`settings.slaThresholds` read/write pair (`router.ts:9726,9753`), and per-tenant threshold
loading in the worker (`sla-imminent-scan.ts:65`).

1. `apps/api/src/trpc/router.ts:9368–9370` — "The SLA hours themselves stay hardcoded in
   @hireops/sla-thresholds … (that stays Phase-3 deferred)." **False.**
2. `apps/internal-portal/src/app/admin/system-setup/SystemSetupClient.tsx:25` — "they stay
   hardcoded". **False.**
3. `apps/internal-portal/src/app/admin/system-setup/page.tsx:16` — "the SLA hours stay
   hardcoded". **False.**
4. `packages/sla-thresholds/src/index.ts:19–22` (header) — "Tenant-configurable thresholds …
   are Phase 3 work — when that lands…". Future tense for something that landed *in this very
   file* (the resolver at line 82 even notes it fulfilled the header's prediction). Mildly
   misleading rather than false.
5. `packages/db/src/schema/candidate-ownership-claims.ts:21,34` — "the 6-month-window state
   machine". The code default is **90 days** (`router.ts:3242`), ~3 months, with per-org MSA
   override. Either the comment or the constant is wrong — see open question 1 before "fixing"
   either.

These are five-minute fixes, but worth doing *before* the pilot: comments this confidently wrong
will mis-scope someone's estimate later (they nearly mis-scoped this audit).

---

## 7. Recommended sequence

**Before the pilot (≈ 2–3 days total):**

1. **E1–E5, the comment fixes** (hours — pending the open-question-1 answer for E5). Cheapest
   credibility protection available.
2. **A1 market-intel note** (S). Highest-visibility surface Solenis will look at; smallest fix.
3. **A3 partner claim-window fallback** (S) — and it resolves the E5 ambiguity properly instead
   of just editing a comment.
4. **A4 imminent-alert window** (S). Completes the SLA story: "thresholds, recipients, *and*
   the warning window are yours."
5. **A2 audio retention** (M). The one M worth pre-pilot: it's a legal/DPO question and "that's
   a per-tenant policy, capped at 90 days" is a strong pilot answer. Extending the existing
   `retentionPolicy` block keeps it cheap.

**Decide (not build) before the pilot:** A5 masking scope — whether widening/staging the mask is
offered needs a product stance first, because it borders the category-B bias-mitigation story.
Same for D1 (`ai_provider`): decide "ops-only by design" and write it down, or schedule the UI.

**After the pilot / with the items-2–5 window:** A6 comp knobs, A8/A9 AI-interview defaults
(S each, but no evidence of demand yet), A10 sender identity (ops-heavy), C1–C3 partner-model
cleanups. **A7 currency is phase-2 Europe work** — the pilot is India-only by client decision;
building multi-currency now would spend a week of the contested window on a non-pilot need.

*(Sizing note for folding into the items-2–5 plan: pre-pilot slice ≈ 2–3 days; the full A list
without A7 ≈ 2–2.5 weeks; A7 alone ≥ 1 week.)*

---

## 8. Open questions (could not resolve from code)

1. **Is the partner claim window commercially supposed to be 90 days or six months?** Code says
   90 (`router.ts:3242`), the schema comment says six months
   (`candidate-ownership-claims.ts:21`). Which number the MSA template / commercial team expects
   is not answerable from the repo.
2. **Is the blind-screening mask's narrow scope a stance or an accident of scoping?** The
   comment (`governance.ts:104–111`) says "a deliberately narrow reading of the ticket …
   easily widened later", which reads like deferred scope, not doctrine. Whether an off-switch
   should ever exist is a product/governance call, not an engineering one.
3. **Will Solenis legal require their own consent/disclosure wording?** Current copy is
   placeholder pending legal review (`legalReviewRequired: true`,
   `ai-interview-session.ts:198`). If tenant wording becomes a requirement, the version
   guarantee needs a per-tenant design (store version *and* full text/hash per consent row) —
   an M/L feature to scope then, not a settings key now.
4. **Should shortlist defaults be recruiter-editable?** They're configured from the shortlist
   view (`ShortlistView.tsx:134`), not `/admin` — every other tenant setting is admin-gated.
   Intentional ownership choice or drift?
5. **What was `partner_tier` meant to drive?** No behaviour found (C1); the original intent
   isn't recoverable from code.
