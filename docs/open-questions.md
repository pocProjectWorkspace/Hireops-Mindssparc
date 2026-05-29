# HireOps — Open follow-ups

Living index of follow-ups that surfaced mid-implementation and don't fit
cleanly into an existing ticket. Captured here so they don't get lost
between commits.

Each entry: what it is, why it matters, what triggers it, and where it
came from (commit / file / HANDOVER reality, so future-you can grep the
history).

For "What's NOT done" at the wave-plan level, see `HANDOVER.md` §4. For
deferred Tier-3 requirements see §4.1. This file is narrower — it tracks
the deltas that surfaced *during* shipped work.

---

## Infrastructure / background jobs

### 1. Scheduled jobs infrastructure

**What.** A way to run periodic Postgres-touching jobs from the API
process (or a dedicated worker), with at-least-once delivery and
locking. Distinct from the Module 3 outbox drainer pattern — that's a
polling loop for queue work, not a scheduler for cron-style periodic
jobs. Initial consumers:

- **audit_logs partition creation** — `audit_logs` is RANGE PARTITIONED
  by `created_at` monthly. Today only the current-month partition
  exists. Without a job creating next month's partition before the
  month rolls over, every audit insert on day 1 of month N+1 fails.
  Run monthly on day 25-ish, idempotent.
- **ownership-claim expiry sweep** — see reality #40 in HANDOVER. The
  partial-unique-active predicate is status-only (Postgres rejects
  `now()` in index predicates). A daily sweep must flip
  `status='active' AND expires_at < now()` → `status='expired'` so new
  claims for the same person aren't blocked by zombie rows.
- **DEK rotation** — eventually KMS-driven, but a sweep that surfaces
  tenants overdue for rotation lands first.
- **Talent-pool consent expiry** — `candidates.talent_pool_consent_expires_at`
  needs an annual sweep to flip consent off and trigger DPDPA-aware
  redaction.

**Why.** Each one is load-bearing for a guarantee the schema implies but
doesn't enforce by itself.

**Trigger.** First — and most urgent — when the current month's
`audit_logs` partition fills. Lower-cost but soon: when DB-PARTNER-A
ownership claims start being created in volume and false-positive
"candidate already claimed" complaints surface.

**Origin.** DB-AUDIT (partition design, migration 0012), DB-PARTNER-A
(HANDOVER reality #40), FND-15d (KEK rotation deferred), DB-03
(talent-pool retention notes).

---

## Schema / migration debt

### 2. `partner_users.user_id` → `auth.users(id)` FK

**What.** Hand-written cross-schema ALTER, same pattern as the existing
`public.users.id → auth.users.id` FK that lives outside the Drizzle
graph.

**Why.** Today `partner_users.user_id` is `uuid NOT NULL` with no FK.
If an `auth.users` row is hard-deleted, the partner_users row dangles.
Catching this at the DB level is cheap insurance.

**Trigger.** When partner onboarding ships (Phase 3) and we start
provisioning real `auth.users` for partners. Could land earlier as
defensive maintenance.

**Origin.** DB-PARTNER-A — schema-file comment in
`packages/db/src/schema/partner-users.ts`.

---

## Documentation debt

### 3. Update `docs/partner-data-model.md` to match the shipped schema

**What.** The doc and the schema we actually built diverged in many
places: column names (`status` enum vs `active` boolean on `partner_orgs`;
`outcome` vs `decision` on dedup attempts), role names (`org_admin` /
`recruiter` in doc vs `partner_admin` / `partner_user` in schema),
ownership-claim columns (the schema added `claimed_via_*` linkage and
`superseded_by_claim_id` self-FK absent from the doc), the
ad-hoc-domain partial-unique condition wording, etc.

**Why.** The doc is now a stale reference. Anyone reading it will write
code against ghost columns.

**Trigger.** Before another engineer touches the partner subsystem, or
before Module 2 (partner submission flow) lands and the doc gets
re-read. Cheap enough to do opportunistically before then.

**Origin.** DB-PARTNER-A final report, deviation #6.

---

## Operational audit queries

### 4. Periodic SQL invariants the DB can't enforce

Run weekly; alert on any non-empty result. Three known ones today:

```sql
-- A: partner-users-not-also-internal (HANDOVER reality #38)
SELECT pu.tenant_id, pu.user_id
FROM partner_users pu
JOIN tenant_user_memberships tum
  ON tum.tenant_id = pu.tenant_id AND tum.user_id = pu.user_id;

-- B: ad-hoc-domain tier-mismatch (HANDOVER reality #42)
SELECT d.id, d.tenant_id, d.domain, o.tier
FROM ad_hoc_partner_domains d
JOIN partner_orgs o
  ON o.tenant_id = d.tenant_id AND o.id = d.partner_org_id
WHERE o.tier <> 'ad_hoc';

-- C: status-vs-expiry drift on ownership claims (HANDOVER reality #40)
SELECT id, tenant_id, person_id, expires_at
FROM candidate_ownership_claims
WHERE status = 'active' AND expires_at < now();
```

**Why.** Standard SQL can't express cross-table CHECK without triggers
(A, B). The active-vs-expiry drift (C) only stops being a stable state
once the sweep job (item #1) is live. Until then, observability of the
drift is the safety bar.

**Trigger.** Wire into whatever scheduled-job infra lands first
(item #1). A standalone cron + email alert would be enough in the
interim.

**Origin.** DB-PARTNER-A — HANDOVER realities #38, #40, #42.

---

## AI infrastructure follow-ups

### 5. `pricing.ts` periodic review

**What.** `packages/ai-client/src/pricing.ts` carries a per-model
micros-per-token table snapshot of Anthropic + OpenAI pricing at AI-01
build time. Pricing drifts every few months; logged `cost_micros`
values drift with it.

**Why.** `ai_usage_logs.cost_micros` underpins per-tenant cost
dashboards (and eventually billing). Stale rates = misleading
dashboards.

**Trigger.** Quarterly review on a calendar (alongside `claude-api`
skill knowledge updates); or whenever the provider pricing page
visibly changes; or whenever a new model lands without a pricing entry
(the table's fallback path emits a `console.warn` — those should be
audited).

**Origin.** AI-01 (`packages/ai-client/src/pricing.ts` file-level
comment).

---

### 6. AI-02-TABLES — mammoth table-cell loss

**What.** Replace `mammoth.extractRawText()` with
`mammoth.convertToHtml()` + a structured post-process that walks the
HTML and preserves table cell content as flat text.

**Why.** Table-heavy DOCX leaks content. The Variant 6 seed CV
(Table_Heavy.docx, 36 KB) extracts only 338 chars because mammoth's
raw-text mode skips inside-table content. The LLM downstream produces
honest-low confidence (0.62) because there's barely anything to parse.

**Trigger.** Confidence floor across real candidates dropping further
than 0.62 (signal: recruiter complaints about excessive "review
carefully" flags on the candidate detail page); or before the 100-CV
corpus run (AI-02-CORPUS backlog ticket) so the corpus measures the
parser-with-fix, not the parser-with-known-bug.

**Origin.** AI-02 final report, smoke results table (Variant 6).

---

### ~~7. Real-provider smoke for AI-01~~ — Anthropic half closed, OpenAI still pending

**Anthropic — CLOSED by AI-03.** The score-application drain calls
Anthropic through the production code path; the AI-03 real-provider
smoke ran end-to-end (Tenant kyndryl-poc, candidate F, ai_usage_logs
row provider=anthropic, model=claude-sonnet-4-6, input_tokens=1371,
output_tokens=452, cost_micros=10893, latency≈9.4s, ai_score=95,
ai_score_explanation.scored_by="anthropic"). The standalone AI-01
`complete()` / `completeStructured()` smoke recipe per HANDOVER #25
is now redundant for Anthropic — AI-03 exercises both code paths
plus the structured-output JSON-schema enforcement.

**OpenAI — STILL OPEN.** Blocked on the missing OPENAI_API_KEY. The
OpenAIAIClient code path has zero real-provider coverage on this
codebase. When the key lands:
  - Provision `ai_openai` credential for a test tenant via
    `storeIntegrationCredential`.
  - Flip the tenant's `tenants.settings.ai_provider` to `'openai'`.
  - Re-run the AI-03 smoke against candidate F (or any pending
    `ai_score_outbox` row).
  - Confirm ai_usage_logs row with provider=openai, model=gpt-5 (or
    whatever the OpenAIAIClient default is), non-zero tokens + cost.

**Origin.** AI-01 final report verification gate 8; AI-03 closed the
Anthropic half end-to-end.

---

## Notifications / email

### 8. Real EmailProvider — SES vs Resend (deferred from Module 3)

**What.** Module 3 ships with `EmailProvider` interface + `LocalEmailProvider`
(writes `dev_email_outbox`) + `RealEmailProviderStub` (throws). Pick a real
provider, build the concrete client, replace the stub. The factory's
`EMAIL_PROVIDER=real` branch already routes there — body change only.

Provider recommendation stands: Resend. Sign-up + DNS work
(SPF/DKIM/DMARC for `notifications@hireops.com`) is the long pole; the
code swap is ~half a day.

**Why.** Real candidate-facing email needs to leave the network. The stub
makes the contract obvious (boot succeeds with `EMAIL_PROVIDER=local`;
fails loudly if anyone flips to `=real` before a provider lands).

**Trigger.** Before the demo where real candidates actually receive mail.
First Wave-1 customer that needs to send real candidate emails (likely
Kyndryl GCC POC graduation). Or the day a recruiter asks "did the
candidate get the rejection email?" against a non-local env.

**Origin.** Module 3 final report, deviation;
`packages/notifications/src/real-stub.ts`.

---

### 9. SLA-imminent scan: 4-hour window is a guess

**What.** `apps/workers/src/jobs/sla-imminent-scan.ts` flags applications
that are within `IMMINENT_WINDOW_HOURS = 4` of their stage SLA threshold.
4h is a pulled-from-air default — the right value depends on how often
recruiters actually check the Hot Zone unprompted.

**Why.** Too short → recruiter gets the alert AFTER missing the SLA.
Too long → spam fatigue. The whole point of the imminent alert is to
nudge before breach.

**Trigger.** First real complaint that the alert was too late OR too
spammy. Probably 30 days of POC use will surface a calibrated number.

**Origin.** Module 3 — Wave 1 implementation guess.

---

### 10. Notification "failed" dashboard

**What.** Rows in `notification_outbox` that hit `attempt_cap` and end
up `status='failed'` go nowhere obvious today. A small admin view (or a
dashboard query) lets an operator see "everything that failed to send in
the last 24h" and decide whether to manually retry / chase up.

**Why.** Outbox-with-cap is correct for production stability, but
silently swallowing failures is bad ops hygiene.

**Trigger.** First production-class deploy (real SES/Resend wired);
becomes load-bearing once the LocalEmailProvider doesn't catch every
failure. Coupled to item #8.

**Origin.** Module 3 — failed status defined; visibility deferred.

---

## Module 4 (offers + Workday) follow-ups

### 11. Offer approval routing (deferred from Module 4)

**What.** Today `extendOffer` sends the offer to the candidate
directly. No approval gate between "drafted" and "extended". The
approval framework schema (`approval_matrices`, `approval_chains`,
`approval_requests`, `approval_decisions`) sits unused for offers.

Concretely needed: the function that takes an offer + matrix and
produces a resolved chain. ~2-3 days of focused work.

**Why.** Enterprise customers (Kyndryl included) typically want
HR / finance / hiring-manager sign-off before an offer goes to the
candidate. Skipping it in Wave 1 is a deliberate Phase-2 simplification
to keep the demo lifecycle simple; production needs this.

**Trigger.** Before Kyndryl signs a contract that promises "no offer
goes out without director approval" — likely Phase 3. Or the engagement
where the rules engine (the second consumer of `approval_*` tables
alongside requisition approvals) lands.

**Origin.** Module 4 ticket scope fence + decision-locked list item
#3 ("Offer approval routing deferred").

---

### 12. Click-is-acceptance disclaimer — verify wording with legal

**What.** The candidate accept page (`/offer/[token]`) renders:
"By clicking Accept Offer, you formally accept this offer of
employment from {tenant_name}." Plus a name-confirmation field as
the weak forwarded-link defence.

**Why.** No e-signature. No OTP. The disclaimer text is the legal
mechanism that turns the click into a binding acceptance. The exact
wording is product-stub; Indian employment law + Kyndryl India legal
need to bless it before a real candidate sees it.

Related but separate decision: formal e-signature provider for Phase 3.
Aadhaar eSign is the strongest option for India; DocuSign or Zoho Sign
as alternatives. ~1-2 weeks integration depending on provider choice.
Worth picking the provider before Phase 3 kickoff.

**Trigger.** Before the first real offer goes out via this flow
(post-POC, pre-production).

**Origin.** Module 4 ticket decision-locked list item #4 + the
`/offer/[token]` page's amber disclaimer banner.

---

### 13. Workday simulator always succeeds — failure-mode coverage

**What.** Wave 1's `drainWorkdayOutboxOnce` deterministically
"simulates" by sleeping 2-3 s then writing a success response.
There's no injected failure path. The schema supports
`status='failed'`, `attempt_count`, `last_error` for the real
connector but the simulator never exercises it. Operators have
nothing to test failure-side UI / runbook against.

**Why.** "Demo theatre" — the gates the simulator passes don't tell
you anything about how the Integration Health screen looks when
things are actually broken. Once the Phase 3 connector lands the
failure path becomes real; we want UI ergonomics validated before
then.

**Trigger.** Phase 3 SOAP connector wiring; OR a deliberate
"chaos-mode" toggle (`WORKDAY_SIM_FAILURE_RATE=0.1`) added before
the next stakeholder demo.

**Origin.** Module 4 ticket decision-locked list item #6.

---

## CRS-01 follow-ups

### 14. Privacy policy real copy (legal review)

**What.** `/privacy` is a stub today
(`apps/internal-portal/src/app/privacy/page.tsx`). The candidate
apply form's consent checkbox links to it; the e-sig disclaimer on
`/offer/[token]` references the same legal posture. Need actual
DPDPA-compliant copy reviewed by legal.

**Why.** The current placeholder reads "Placeholder copy. The
production privacy policy for this tenant is pending legal review."
Fine for a recruiter-team-only POC; unacceptable for any
candidate-facing launch.

**Trigger.** Before the first external candidate is invited to use
the apply URL.

**Origin.** CRS-01 scope fence; item #12 above is the related
e-sig legal review (same surface).

---

### 15. CAPTCHA / rate limit / abuse defences on apply form

**What.** `POST /api/upload/resume` and the `submitApplication` tRPC
mutation are both unauthenticated. No rate limit, no proof-of-work,
no CAPTCHA. A bot could spam applications and storage buckets cheaply.

**Why.** POC traffic doesn't need it. Public production deploys need
at least IP-level rate limiting + a CAPTCHA gate (hCaptcha or
Turnstile). CRS-01 explicitly punted.

**Trigger.** Wave-1 production deploy with real candidate traffic,
OR before the apply URL is shared more widely than internal demos.

**Origin.** CRS-01 ticket scope fence.

---

### 16. "How did you hear about us" → verbatim storage

**What.** The apply form's optional "How did you hear about us?" free
text is heuristically mapped to the `applications.source` enum and
the verbatim string is stashed in
`candidate_dedup_attempts.submission_metadata.sourceText`. The CRS-01
ticket originally asked for verbatim storage but there's no
dedicated column.

**Fix options.** (a) Add `applications.source_text text NULL`, (b)
lift the dedup-attempts jsonb storage to applications, or (c)
accept the heuristic + jsonb stash. Recommend (a) when the
recruiter detail page lands an "Original source" line; (c) is
sufficient until then.

**Trigger.** First recruiter complaint that the raw source text
isn't visible on the candidate detail page.

**Origin.** CRS-01 ticket text vs. schema reality.

---

### ~~17. Apply form file types — legacy `.doc` + 5 MB cap~~

**Partially resolved by CRS-01-FOLLOWUP.** The 10 MB cap landed
(HANDOVER reality #35 updated). Legacy `.doc` remains deferred — see
the new item #21 below for the textract/antiword evaluation, which
is the actual question.

---

### ~~18. Button primary `bg-brand-500` fails WCAG-AA contrast~~

**Resolved by CRS-01-FOLLOWUP.** `Button` primary variant lifted to
`bg-brand-600` (5.2:1) with hover at `bg-brand-700` (7.4:1) in
`packages/ui/src/components/Button.tsx`. The per-call workaround on
the apply form's submit button was removed in the same change. Other
brand-500 uses (Checkbox/Radio/Switch checked indicators, focus
outlines) are non-text UI elements that satisfy the WCAG 3:1
graphical threshold and remain on brand-500.

---

### 19. `candidate-uploads` storage bucket provisioning runbook is missing

**What.** `apps/api`'s `SupabaseStorageClient` writes to the
`candidate-uploads` bucket. On a fresh dev Supabase project the
bucket doesn't exist; uploads fail with "Bucket not found".
HANDOVER §4.5/34 says "documented in CONTRIBUTING.md" but
CONTRIBUTING.md doesn't actually have the steps today.

**Fix options.** Add a runbook section to CONTRIBUTING.md OR write a
`pnpm db:provision:bucket` script that creates it idempotently via
the service role key. Dev escape hatch (`STORAGE_PROVIDER=local`)
covers testing but production needs the real bucket.

**Trigger.** Next engineer who runs the apply form locally, OR the
first production deploy.

**Origin.** CRS-01 e2e investigation — caught the missing bucket in
the dev Supabase project.

---

### 20. CORS allow-list defaults are dev-friendly, not prod-safe

**What.** `apps/api`'s new CORS middleware reads
`CORS_ALLOWED_ORIGINS` (comma-separated) and falls back to
`http://localhost:3000`/`3002`/`3003` if unset. The fallback exists
so a misconfigured local env can't lock everyone out, but it ALSO
means a production deploy that forgets the env var would silently
accept localhost-only origins (still secure — no real prod traffic
matches localhost — but obscure to debug).

**Fix.** Add a startup-time warning if `NODE_ENV=production` and
`CORS_ALLOWED_ORIGINS` is unset. Or make it fatal in prod. Same
shape as the FND-15d KMS provider check.

**Trigger.** Pre-production hardening cycle.

**Origin.** CRS-01 CORS middleware added to `apps/api/src/index.ts`.

---

### 21. Legacy `.doc` support on the upload + parser path

**What.** The apply form accepts PDF + DOCX. Legacy `.doc` (Word
97-2003 binary) is excluded because mammoth — AI-02's docx extractor
in `packages/ai-client/src/parsers/extract.ts` — is `.docx`-only.
Accepting `application/msword` at the upload endpoint without parser
support would silently parse_failed every `.doc` submission: the
application row + raw file land, but `parsed_skills` stays null and
the recruiter sees a candidate detail page with no parsed fields.

**Options.**
  - **textract + antiword/wv shellouts.** Most common Node path for
    legacy `.doc`. Requires native binaries in the deployment image,
    adds a build-time dep, opens a parser-corpus test surface. Real
    parsing, real cost.
  - **Pure-JS extractor.** A handful exist (e.g. `word-extractor`)
    but quality varies; would need its own corpus pass before
    trusting.
  - **Accept-and-parse_failed.** Loosen the upload allowlist + let
    the parser fail cleanly. Candidates aren't rejected outright but
    the recruiter sees an empty parse. Marginal UX gain over the
    current "PDF or DOCX only" rejection.
  - **Stay closed.** Indian candidate corpus still has a long tail
    of `.doc`, but the share is shrinking. Telling candidates to
    save-as `.docx` is cheap.

**Trigger.** Parser corpus measurement showing >5% real-applicant
rejection on `.doc` upload attempts, OR a single high-value
candidate complaint.

**Origin.** CRS-01-FOLLOWUP — the upload cap bump (5 → 10 MB)
landed but `.doc` support was deferred at the stop-and-ask gate
(user picked "defer .doc; bump cap only").

---

### 22. `tenant-context.test.ts` Test 7 asserts absolute BU count, not RLS isolation

**What.** `apps/api/test/tenant-context.test.ts:336` asserts
`visible.length === 1` after inserting one BU into the test user's
tenant. The intent is to prove tenant isolation — that the synth
tenant's BU is NOT visible. The actual assertion (absolute count)
fails whenever ANY other row exists in the test user's tenant.

**Why it fails today.** `pnpm db:seed:demo-data`
(`packages/db/src/scripts/seed-demo-data.ts:569-573`) inserts a
'gcc-blr' BU into the same `kyndryl-poc` tenant the test user
belongs to. Post-seed there are 2 BUs visible, and the test fails
with `visible.length=2`. On a fresh DB (no demo seed) the test
passes. CRS-01's final report wrote this off as "pre-existing — not
introduced by CRS-01"; that's true but the underlying bug is in the
test, not the seed.

**Evidence.**
  - Test asserts `assert.equal(visible.length, 1, ...)` at
    `tenant-context.test.ts:336`.
  - Seed inserts `(tenant_id=${kyndryl-poc-id}, slug='gcc-blr')` at
    `seed-demo-data.ts:571`.
  - Test passes on a freshly-migrated DB without the demo seed;
    fails after `pnpm db:seed:demo-data` has run.

**Recommended fix (one sentence).** Replace `visible.length === 1`
with two positive assertions: `bangalore-gcc` IS in `visible` AND
the synth `invisible` slug is NOT — proves RLS isolation without
caring whether the seed has populated other rows in the same tenant.

**Trigger.** Anyone re-running the full api test suite after seeding
the demo data; flake will keep firing until the assertion is
rewritten.

**Origin.** CRS-01-FOLLOWUP diagnosis (no code fix in this push —
fix lives as a follow-up ticket alongside the next clean-up sweep).

---

## AI-03 follow-ups

### 23. Re-scoring when jd_skills (or the JD body) changes

**What.** AI-03 is submit-time scoring only. The `ai_score_outbox`
table enforces compound unique `(tenant_id, application_id)` —
one scoring attempt per application, ever. If a recruiter edits the
JD skills or weights after applications have come in, every existing
candidate's score becomes stale against the new context.

**Why deferred.** CRS-01 / AI-03 scope fence. Wave 1 hands the
recruiter a "stale score, please re-run" UI affordance is a Phase 3
concern. The schema today doesn't track "what version of jd_skills
was the score computed against"; re-scoring needs that lineage to
avoid silent score regressions.

**Fix sketch.** Add `applications.ai_scored_jd_version_id` (FK to
`jd_versions`) so the recruiter UI can flag stale scores. Add a
"rescore" tRPC mutation that enqueues a fresh row to a new
`ai_score_outbox` partial-unique on `(tenant_id, application_id,
jd_version_id)`. Worker drains as today, writes the new score with
the new prompt_version + the new jd_version_id.

**Trigger.** First recruiter complaint that "Anika's score doesn't
reflect the new skills weight" — likely Phase 2 → Phase 3 hand-off.

**Origin.** AI-03 scope fence (submit-time scoring only).

---

### 24. Momentum Feed NULL-score UI handling

**What.** The recruiter triage page sorts candidates by `ai_score`.
Candidates whose score is still pending (worker hasn't drained) or
who were skipped (knockouts failed, parser confidence below floor)
have `ai_score = NULL`. Today the sort just buries them at the
bottom of the descending list, with no visual cue distinguishing
"pending real score" from "skipped — knockouts failed" from
"skipped — parser confidence too low".

**Fix sketch.** Read `ai_score_explanation.scored_by` to bucket:
  - `'skipped'` + reason → grey badge "Skipped: knockouts failed"
    or "Skipped: low parse confidence"
  - NULL explanation → blue badge "Score pending"
  - any provider name → render the numeric score as today

**Trigger.** First production-class deploy. Or when a recruiter
asks "why is candidate X at the bottom with no score".

**Origin.** AI-03 scope fence — Momentum Feed bucketing was
explicitly punted.

---

### 25. OpenAI real-provider smoke remains pending

**What.** AI-01 verification gate 8 covered both Anthropic and OpenAI
real-provider smoke. AI-03 closed the Anthropic half; OpenAI is still
unverified end-to-end (LocalAIClient covers its code path, but the
OpenAIAIClient against the real OpenAI API has never run on this
codebase).

**Fix.** Once `OPENAI_API_KEY` is in `.env`:
  - `storeIntegrationCredential({ integrationType: 'ai_openai', ... })`
    for a test tenant.
  - Flip `tenants.settings.ai_provider` to `'openai'`.
  - Run the AI-03 smoke recipe against a candidate with a pending
    `ai_score_outbox` row.
  - Verify `ai_usage_logs.provider = 'openai'`, non-zero tokens +
    cost, and `applications.ai_score_explanation.scored_by =
    'openai'`.

**Why.** Cost attribution + provider failover diligence. The OpenAI
path is one tenant-setting flip away from production on day one;
zero real-provider coverage is irresponsible.

**Trigger.** OPENAI_API_KEY availability.

**Origin.** AI-01 gate 8 (was open-question #7 prior to AI-03; the
Anthropic half closed via AI-03, this is the residual).

---

### 26. Worker registry refactor

**What.** AGENT-01a brings the polling-worker total to 6:
`notification-drain`, `workday-sync-drain`, `ai-score-drain`,
`dedup-attempt-cleanup`, `agent-run-drain` (AGENT-02+),
`agent-stale-scan` (AGENT-02+). Each is independently wired in
`apps/workers/src/index.ts` with hard-coded `intervalMs`, ad-hoc
graceful-shutdown logic, no shared metrics surface, no shared health
check.

**Fix.** Refactor to a registry pattern before adding a 7th drain. Each
worker declares itself with `{ name, drainFn, intervalMs, concurrency,
healthCheckFn }` and registers into a common runner that handles
lifecycle, metrics emission, and graceful shutdown. The runner becomes
the single place to wire Sentry tags, request-id propagation per drain
tick, and per-worker concurrency caps.

**Why.** Each new drain loop currently copies ~30 lines of timer +
in-flight-tracking + signal-handling code. Six instances of this is
fine; seven becomes the trigger for the refactor.

**Trigger.** Adding the 7th polling worker.

**Origin.** AGENT-01b reality #100.

---

## Lifecycle

This file lives alongside `HANDOVER.md` as a working index — append
when a follow-up surfaces, strike-through (or move to a "resolved"
section) when shipped. Don't let it become a dumping ground: if an item
sits here for a wave without movement, it either belongs in the
backlog (file a ticket) or it's not real (delete).

### Closed / promoted since last pruning

- **AI-02-CORPUS (100-CV parser quality gate)** — promoted to Phase 3
  backlog as a named ticket with its own scope. No longer a loose
  follow-up.
- **SEED-DEMO** — shipped.
- **SLA threshold extraction to shared package** — shipped (now in
  `packages/sla-thresholds`).
- **CRS-01 (apply form) and AI-03 (real AI scoring)** — these are the
  next tickets, not follow-ups; removed from this file.
