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
locking. Initial consumers:

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
re-read.

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

### 6. AI-02-CORPUS — 100-CV parser quality gate (Phase 3 hardening)

**What.** Phase 3 ticket. Build the 100-CV Indian corpus per
`requirements.md` §5.3 line 193, run the parser end-to-end against it,
assert the ≥95% accuracy gate on key fields (name / email / phone /
total_years_experience / education / skills).

**Why.** AI-02 shipped against 4-5 seed CVs — that's a Phase 2
"parser works" bar, not the contractual quality bar.

**Trigger.** Phase 3 hardening cycle. Not blocking anything in Phase 2.

**Origin.** AI-02 ticket scope fence (out of scope per the ticket).

---

### 7. AI-02-TABLES — mammoth table-cell loss

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
corpus run (item #6) so the corpus measures the parser-with-fix, not
the parser-with-known-bug.

**Origin.** AI-02 final report, smoke results table (Variant 6).

---

### 8. Real-provider smoke for AI-01

**What.** Run the AI-01 smoke recipe (documented in HANDOVER reality
#25) against real Anthropic + OpenAI keys, verify
`ai_usage_logs` rows with non-zero tokens + cost end-to-end. Smoke
script itself was deleted before AI-01 commit per the FND-OPS pattern;
recreate from the recipe when running.

**Why.** Gate 8 of AI-01 was the only verification gate that didn't
land — the LocalAIClient suite covers the path, but neither real
provider has been hit through the production code path on this
codebase.

**Trigger.** Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` available
in the env. Anthropic key is present (used by AI-02 smoke), OpenAI key
is the missing piece.

**Origin.** AI-01 final report, verification gate 8 (blocked on keys).

---

## Notifications / email

### 9. Real EmailProvider — SES vs Resend (deferred from Module 3)

**What.** Module 3 ships with `EmailProvider` interface + `LocalEmailProvider`
(writes `dev_email_outbox`) + `RealEmailProviderStub` (throws). Pick a real
provider, build the concrete client, replace the stub. The factory's
`EMAIL_PROVIDER=real` branch already routes there — body change only.

**Why.** Real candidate-facing email needs to leave the network. The stub
makes the contract obvious (boot succeeds with `EMAIL_PROVIDER=local`;
fails loudly if anyone flips to `=real` before a provider lands).

**Trigger.** First Wave-1 customer that needs to send real candidate
emails (likely Kyndryl GCC POC graduation). Or the day a recruiter
asks "did the candidate get the rejection email?" against a non-local
env.

**Origin.** Module 3 final report, deviation; `packages/notifications/src/real-stub.ts`.

### 10. SLA-imminent scan: 4-hour window is a guess

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

### 11. Notification "failed" dashboard

**What.** Rows in `notification_outbox` that hit `attempt_cap` and end
up `status='failed'` go nowhere obvious today. A small admin view (or a
dashboard query) lets an operator see "everything that failed to send in
the last 24h" and decide whether to manually retry / chase up.

**Why.** Outbox-with-cap is correct for production stability, but
silently swallowing failures is bad ops hygiene.

**Trigger.** First production-class deploy (real SES/Resend wired);
becomes load-bearing once the LocalEmailProvider doesn't catch every
failure.

**Origin.** Module 3 — failed status defined; visibility deferred.

## Lifecycle

This file lives alongside `HANDOVER.md` as a working index — append
when a follow-up surfaces, strike-through (or move to a "resolved"
section) when shipped. Don't let it become a dumping ground: if an item
sits here for a wave without movement, it either belongs in the
backlog (file a ticket) or it's not real (delete).
