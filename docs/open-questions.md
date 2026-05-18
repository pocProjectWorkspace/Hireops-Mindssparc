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

### 7. Real-provider smoke for AI-01

**What.** Run the AI-01 smoke recipe (documented in HANDOVER reality
#25) against real Anthropic + OpenAI keys, verify
`ai_usage_logs` rows with non-zero tokens + cost end-to-end. Smoke
script itself was deleted before AI-01 commit per the FND-OPS pattern;
recreate from the recipe when running.

**Why.** Gate 8 of AI-01 was the only verification gate that didn't
land — the LocalAIClient suite covers the path, but neither real
provider has been hit through the production code path on this
codebase.

**Status.** Anthropic-half can run today (key is in .env, used by
AI-02 smoke). **Blocked on OpenAI key** for the second provider.
Worth doing the Anthropic-only half now and leaving the OpenAI
verification annotated as the remaining gap.

**Origin.** AI-01 final report, verification gate 8 (blocked on keys).

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

### 17. Apply form file types — legacy `.doc` + 5 MB cap

**What.** CRS-01 ticket asked for PDF / DOC / DOCX up to 10 MB. The
existing `POST /api/upload/resume` (HANDOVER reality #35) accepts
PDF / DOCX only with a 5 MB cap. CRS-01 reused as-is.

**Fix.** Two follow-ups:
  - Legacy `.doc` (`application/msword`) — add to the MIME allowlist
    + verify mammoth / textract handles it (likely a small change).
  - Raise cap to 10 MB if real applicants need it. Most CVs are
    < 1 MB; image-heavy portfolio decks for designers exceed 5 MB.

**Trigger.** First "my CV won't upload" recruiter complaint, OR
parser corpus measurement showing >5% rejection on real applicants.

**Origin.** CRS-01 ticket vs. HANDOVER reality #35.

---

### 18. Button primary `bg-brand-500` fails WCAG-AA contrast

**What.** `@hireops/ui` `Button variant="primary"` defaults to
`bg-brand-500` (#3b82f6) on white. axe measures 3.67:1 contrast,
below the 4.5:1 normal-text threshold. CRS-01 worked around per-call
on the apply form's submit button via
`className="bg-brand-600 hover:bg-brand-700 ..."`. The /triage axe
scan passes only because no default-state primary buttons are
visible there.

**Fix.** Change the `primary` variant's default to brand-600
(5.2:1) with hover at brand-700 (7.4:1). Small visual shift, big
accessibility win, applies system-wide once.

**Why.** Without the fix, every new candidate-facing or login-
adjacent surface needs the same per-call override; drift is certain.

**Trigger.** Next design-system sweep, OR when a second consumer
surface (careers site, partner portal) needs the override.

**Origin.** CRS-01 axe scan on `/t/[tenant]/apply/[req]`.

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
