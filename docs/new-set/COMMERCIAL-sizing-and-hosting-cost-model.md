# HireOps — build sizing & SaaS hosting cost model

**Purpose:** the input variables for pricing HireOps to a client.
**Date:** 18 August 2026 · **Basis:** measured against `main` @ `0219883` + uncommitted R1 work.
**Status:** internal working document. Every rate marked ⚠️ must be re-confirmed against the
vendor's current list price at the moment of quoting — this document owns the *formulas and
drivers*, not the prices.

---

## 0. How to read this

Two numbers get conflated in pricing conversations and they must not be:

- **Reconstruction cost** (§2) — what it would cost a conventional team to build what exists.
  This is the *value anchor* for a licence/deal conversation.
- **Run cost** (§3–§6) — what it costs per month to operate it for a tenant.
  This is the *COGS floor* under any subscription price.

Margin lives between run cost and price. Reconstruction cost tells you whether the price is
defensible; it does not tell you what to charge.

---

## 1. What actually exists — measured, not estimated

All counts are from the working tree, excluding `node_modules`, `.next`, build output and the
16 stale agent worktrees.

| Dimension | Measured |
|---|---|
| Total TypeScript/TSX/SQL | **~205,400 LOC** |
| — production code | ~157,300 LOC |
| — test code | **48,091 LOC across 123 test files** |
| Database tables (`pgTable`) | **96** |
| Tables with RLS policies | **92** |
| Migrations | **108** (4,978 lines of SQL) |
| tRPC procedures | **291** |
| `router.ts` size | 30,003 lines (a known structural debt — see §7) |
| Public HTTP route modules (Hono) | 8 |
| Next.js pages | **95** (83 internal portal, 12 partner portal) |
| Admin configuration surfaces | 23 |
| Email templates | 17 |
| Governed AI features | **11** feature keys, 14 call sites |
| AI providers supported | 2 (Anthropic, OpenAI) with per-tenant BYO keys |
| Background workers | 5 scheduled jobs + 3 outbox drains |
| Vector DB / embeddings | **none — zero occurrences** |

**Applications:** `apps/api` (90.6k LOC), `apps/internal-portal` (56.5k), `apps/partner-portal`
(5.5k), `apps/workers` (2.9k). **Shared packages:** `db` (24.9k), `api-types` (13.6k),
`email-templates` (3.3k), `ui` (2.1k), `ai-client` (1.9k), `agent-actions` (1.9k), plus
`ai-scoring`, `notifications`, `observability`, `sla-thresholds`.

**Functional footprint:** requisitions & approvals, candidate pipeline & triage, AI scoring,
interviews & panel, offers & compensation, onboarding (incl. BGV, IT provisioning, assets,
L&D), offboarding (incl. exit interviews, settlements, asset return), partner/agency portal
with commercial terms, a 9-report analytics module on a shared semantic layer, the Iris
transactional assistant, and a DPDPA compliance layer (audit, PII access log, retention,
consent).

---

## 2. Reconstruction effort — man-months

**Method.** Sized functionally per module and cross-checked against LOC. The LOC check:
157,300 production LOC at a sustained 1,800–2,200 LOC/developer-month for multi-tenant
enterprise SaaS with RLS, audit triggers and a real test suite gives 71–87 developer-months.
The functional decomposition below lands in the same band, which is why I'm confident in it.

"Developer-month" = one experienced full-stack engineer for one month, *including* their
share of design, code review, rework and defect fixing. It excludes PM, BA, QA lead, UX and
DevOps, which are added as an overlay.

### 2.1 Engineering build

| Workstream | Dev-months | Notes |
|---|---:|---|
| Platform foundation | 5.0 | Multi-tenant schema, 96 tables, RLS on 92, audit triggers, migration discipline, `withTenantContext`, envelope encryption |
| Auth, roles & access control | 3.0 | Supabase Auth, 8+ personas, double-gate role pattern, partner + candidate signed-link access |
| Requisitions & approvals | 4.5 | Matrix→chain→request→decision model, routing config, revision suggestions |
| Candidate pipeline & triage | 4.5 | Applications, state transitions, dedup, shortlist, missing-info loop |
| AI layer & governance | 4.0 | 11 feature keys, kill switches, model allowlist, BYO keys, cost logging, prompt provenance, budget alerting |
| Iris assistant | 3.0 | 12 actions, 3 entry modes, intent resolution, help mode, kill switch |
| Interviews & panel | 3.5 | Scheduling, confirm links, panel pools, feedback, scorecards, prep |
| Offers & compensation | 3.0 | Comp bands, benchmarks, offer lifecycle, e-sign seam, approvals |
| Onboarding | 4.0 | Cases, tasks, documents, BGV, IT provisioning, assets, L&D |
| Offboarding | 2.5 | Cases, exit interviews, asset return, final settlement |
| Partner / agency portal | 4.0 | Separate app, empanelment, invitations, submissions, ownership claims, MSA + fee accrual |
| Reporting & analytics | 4.0 | Semantic layer, 9 reports, catalog, filters, CSV export, digests |
| Admin configuration | 4.0 | 23 admin surfaces, each a governed settings block |
| Notifications & email | 2.0 | Outbox, dedup, 17 templates, Resend provider, attachments |
| Background workers | 1.5 | Scheduler with advisory locks, 5 jobs, 3 drains, `SKIP LOCKED` |
| Compliance & privacy | 3.0 | DPDPA consent, retention, PII access log, partitioned audit, erasure |
| Integrations scaffolding | 1.5 | Credential vault, BGV/calendar/e-sign/AI provider seams |
| **Engineering subtotal** | **56.5** | |
| Automated testing | 9.0 | 48k LOC / 123 files, incl. DB-backed integration suites |
| Architecture & tech leadership | 4.0 | Sustained across the build |
| DevOps, CI/CD, environments | 3.5 | Multi-app deploy, migrations, secrets, monitoring |
| **Build total** | **73.0 dev-months** | |

### 2.2 Non-engineering overlay

| Role | Person-months | Basis |
|---|---:|---|
| Product / BA | 8.0 | ~11% — heavy domain specification |
| UX / UI design | 6.0 | 95 pages, a design system, 8 personas |
| QA (manual/exploratory, UAT) | 7.0 | Beyond the automated suite |
| Project management | 5.5 | ~8% |
| **Overlay total** | **26.5** | |

### 2.3 Headline

> **~99 person-months (~73 developer-months) to reconstruct HireOps as it stands.**
> Practical shape: **a 8–9 person team over 11–12 calendar months.**
> Defensible range: **85–115 person-months**, driven mostly by how much of the AI governance,
> partner commercials and compliance layer a client considers in scope.

**Important caveat for internal use.** This is *reconstruction* cost with a conventional team.
It is **not** what this build actually consumed — HireOps was built AI-assisted on a
substantially compressed timeline. Use the reconstruction figure to justify licence value and
to price change-requests; do not present it as incurred cost, because it isn't, and that
misrepresentation is both unnecessary and fragile under scrutiny.

### 2.4 What is *not* in the 99

Deliberately excluded because they are unbuilt or gated:

| Item | Extra person-months | Status |
|---|---:|---|
| Workday bi-directional integration | 6–10 | Deferred work package; `workday-client` is an empty stub |
| Interview notetaker (capture→transcript→notes) | 5–7 | Phase R2, designed not built |
| Diversity reports (#13/#14) | 3–5 | Blocked on legal sign-off; needs demographics capture + k-anonymity |
| Quality-of-hire / early attrition (#12) | 2–3 | Needs the HRMS post-hire write-back loop |
| SOC 2 Type II readiness | 6–9 | See §6 |
| Data migration from incumbent ATS | 2–4 | Per client, see the implementation checklist |
| PDF/board-pack export engine | 1–2 | Deliberately deferred; print styling used instead |

---

## 3. App-level cost drivers

These are the *volume variables* that move every downstream infrastructure number. Every
client conversation should establish these before any hosting figure is quoted.

| # | Variable | Why it drives cost | Typical mid-market |
|---|---|---|---|
| A1 | Tenants (client orgs) | RLS scoping is per-tenant; drives DB row counts, not compute | 1 per contract |
| A2 | **Named internal users** | Supabase Auth MAU; licence seat basis | 50–300 |
| A3 | **Monthly active users** | Function invocations, bandwidth | 60–70% of A2 |
| A4 | Requisitions / year | Root of the pipeline volume | 200–1,000 |
| A5 | **Applications / year** | **Single biggest AI cost driver** — every one is scored | 20–100× A4 |
| A6 | Interviews / year | Notes, prep, feedback, calendar, notetaker minutes | 3–6× hires |
| A7 | Hires / year | Onboarding cases, offers, fee accruals | 5–20% of A4 |
| A8 | Offboardings / year | Offboarding cases, settlements | ~= attrition × headcount |
| A9 | **Documents stored + avg size** | Storage GB, egress, retention duration | 5–15 docs/candidate @ ~1–3 MB |
| A10 | Document retention period | DPDPA `retention_years`; storage compounds | 3–8 years |
| A11 | Emails / month | Resend tier | ~8–15 per application lifecycle |
| A12 | Partner/agency orgs + users | Second app's load, submissions | 5–50 orgs |
| A13 | Report runs + digest recipients | Heavy aggregate SQL at request time | 100s/month |
| A14 | Peak concurrency | Compute sizing; hiring is seasonal/bursty | 3–5× mean |
| A15 | Data residency requirement | **Can force region choice and re-price everything** | IN / EU / US |
| A16 | Environments required | Each non-prod is a near-full cost copy | prod + staging + UAT |
| A17 | Historical data migrated | One-off effort + permanent storage baseline | varies |
| A18 | AI features enabled per tenant | Each of 11 keys is independently switchable | client choice |

**The compounding one to watch is A5 × AI-features-enabled.** Applications drive resume
parsing *and* AI scoring, both per-application. A client at 50,000 applications/year has a
materially different AI bill from one at 5,000, on identical seat counts. Price AI on volume,
not on seats, or you will lose money on high-volume recruiters.

---

## 4. Infrastructure-level cost model

Current architecture: **Supabase** (Postgres + Auth + Storage), **Vercel** (two Next.js apps),
**Fly.io** (workers), **Resend** (email), **Sentry** (errors). Optional **AWS KMS**.

### 4.1 Line items

| # | Component | Billing driver | Notes / risk |
|---|---|---|---|
| I1 | Postgres compute | Instance size, always-on | **All analytics is request-time raw SQL — no read replica, no materialized views.** Reports compete with transactional load. First thing to break at scale. |
| I2 | Postgres storage | GB + growth rate | 96 tables; audit log is monthly-partitioned and grows unbounded without a prune policy |
| I3 | PITR / backups | Retention window | Enterprise clients typically demand ≥7 days PITR |
| I4 | Read replica | Optional, +~100% of I1 | Not currently used; the fix when reports start hurting |
| I5 | Connection pooling | Included, but **pooler contention is already an observed failure mode** in test runs | Budget for a bigger pooler tier |
| I6 | Supabase Auth | **MAU** | Scales with A3 |
| I7 | Object storage | GB stored + egress | A9 × A10. Audio for the notetaker changes this materially — see §5.3 |
| I8 | Vercel — 2 projects | Function invocations, active CPU, bandwidth, builds | Fluid Compute; 300s default timeout |
| I9 | Fly.io workers | Always-on instance(s) | 5 scheduled jobs; must not scale to zero |
| I10 | Resend | Emails/month tier | A11. **Currently in test mode — only delivers to the owner inbox.** Production requires a verified sending domain |
| I11 | Sentry | Event volume, retention | |
| I12 | KMS | Key ops + key count | Envelope encryption for BYO AI keys and credentials |
| I13 | Log retention | GB × retention | Compliance may dictate the window |
| I14 | Non-production envs | **Multiply I1–I13 by ~0.4–0.6 each** | A16. Most commonly under-budgeted item |
| I15 | CDN / bandwidth | Egress GB | Document downloads dominate |
| I16 | Domains, TLS, DNS | Flat | Minor |
| I17 | Uptime/synthetic monitoring | Checks/month | |
| I18 | DR / cross-region | Doubles the critical path if contracted | Only if the SLA demands it |

### 4.2 Structural notes that affect the quote

1. **No read replica and no materialized views.** Documented and accepted at POC scale. Every
   report is raw SQL inside the tenant transaction at request time. Budget either a replica
   (I4) or a materialization ticket before a heavy-reporting client goes live.
2. **The worker cannot scale to zero.** Five scheduled jobs including SLA scans and the
   ownership-claim sweep — and that sweep is *load-bearing for data correctness*, not a
   nicety. An always-on instance is mandatory.
3. **Two Vercel projects, and the partner portal is still CLI-deployed**, not git-connected.
   That is a release-engineering gap to close before a production contract.
4. **Audit log is monthly-partitioned but has no automated prune.** Storage grows forever.
   Agree a retention window with the client and build the prune, or this becomes a slow leak.
5. **Egress is the sleeper.** Document-heavy tenants (A9 × downloads) can make bandwidth
   exceed compute.

---

## 5. AI, vector DB and notetaker — explicit cost model

### 5.1 The rate table the platform actually bills against

From `packages/ai-client/src/pricing.ts`, in USD per million tokens (input/output):

| Provider | Model | Logged rate | Real list ⚠️ |
|---|---|---|---|
| Anthropic | `claude-sonnet-4-6` / `-4-5` / `-4` | $3 / $15 | $3 / $15 ✓ |
| Anthropic | `claude-opus-4-7` / `-4-6` | $15 / $75 | $15 / $75 ✓ |
| Anthropic | `claude-haiku-4-5` | **$1 / $4** | $0.80 / $4 — **logged +25% high** |
| OpenAI | `gpt-5` | **$1 / $10** | $1.25 / $10 — **logged −20% low** |
| OpenAI | `gpt-5-mini` | $1 / $2 | ⚠️ confirm |
| OpenAI | `gpt-5-nano` | $1 / $1 | ⚠️ confirm |
| OpenAI | `gpt-4.1` / `-mini` | $2 / $8, $1 / $2 | ⚠️ confirm |

> **Material finding.** Rates are stored as *integer* micros-per-token, so any real price that
> isn't a whole dollar-per-million is rounded. `ai_usage_logs.cost_micros` is therefore
> **indicative, not invoice-accurate**. If AI is priced to the client as a pass-through or a
> metered line, reconcile against provider invoices monthly, and fix the table to fractional
> precision first. Defaults for unknown models fall back to Sonnet/gpt-4.1 rates with a
> `console.warn` — so a new model silently bills at a stand-in rate until someone updates it.

### 5.2 Per-tenant AI cost formula

```
Monthly AI cost =
    (A5/12) × resume_parse_tokens   × rate(parser_model)
  + (A5/12) × ai_scoring_tokens     × rate(scoring_model)
  + Σ(on-demand features: JD gen, bias review, feasibility, comp rationale,
      recruiter brief, interview prep, feedback summary, req revision)
      × invocations/month × tokens × rate(model)
  + iris_sessions/month × (intent + draft) tokens × rate(model)
  + agent_drafts/month × tokens × rate(model)
```

**The two per-application features (resume parsing + AI scoring) dominate**, because they fire
on every single application rather than on a click. The other nine are user-initiated and
scale with recruiter behaviour, not applicant volume.

Cost controls already built and worth selling as such: per-feature kill switches, a model
allowlist, per-tenant BYO API keys (moves AI spend to the client's own provider bill entirely),
`ai_usage_logs` cost ledger, monthly budget with threshold alerting, and a linear month-end
projection. The hard spend cap that *blocks* calls at 100% is deliberately **not** built
(deferred as T5.1b) — alerting only. Say so explicitly rather than implying a cap exists.

**Commercial recommendation:** offer BYO-key as the default for any high-volume client. It
converts your most volatile COGS line into their procurement problem and removes the
reconciliation risk in §5.1.

### 5.3 Notetaker — a genuinely new COGS line

Not yet built. When switched on, three stacked costs per recorded interview:

```
Per interview =
    ASR/bot minutes × rate_per_minute          ⚠️ confirm vendor list price
  + transcript_tokens × summarisation_rate
  + audio_MB × storage_rate × retention_months
```

| Driver | Note |
|---|---|
| Recorded interviews/month | A6 × recording-consent rate — **consent is per-interview and refusable, so this is < 100%** |
| Avg interview minutes | 30–60 typical |
| ASR/bot per-minute rate | Bills **per meeting-minute regardless of BYO LLM key** — BYO does not protect this line |
| Transcript → notes tokens | ~1 hour of speech ≈ 8–10k input tokens |
| Audio retention | Longest-lived, largest object the platform would store |

**Three consequences for pricing:**
1. `recordAIUsage` covers the **LLM half only**. The ASR half needs its own cost row or AI
   spend reporting will understate the true figure.
2. Consent is refusable per interview, so revenue-per-seat is stable but cost-per-seat is not.
   Meter it, or cap included minutes.
3. Storage retention on audio can exceed the transcript's usefulness. Recommend a short audio
   retention with an indefinite transcript/notes retention.

### 5.4 Vector database — **not currently required**

**There are zero embeddings, zero vector columns and no vector store in the codebase.** Do not
put a line item in the quote for it today.

It becomes necessary only if the client asks for one of:

| Trigger | What it needs |
|---|---|
| Semantic resume/candidate search ("find me people like this hire") | Embeddings per candidate + vector index |
| Talent-pool re-matching against new requisitions | Same, plus recompute on JD change |
| RAG over interview transcripts (a natural notetaker follow-on) | Chunk + embed transcripts |
| JD similarity / dedup | Embeddings per JD |

Cheapest credible path is **pgvector inside the existing Supabase Postgres** — no new vendor,
no new network hop, RLS still applies, and it reuses the tenant-scoping the whole platform is
built on. Cost = embedding generation (one-off per document + on change) + marginal storage +
index memory. A separate managed vector vendor is only justified above roughly single-digit
millions of vectors, and would need its own tenant-isolation story built from scratch — which
is a real security cost, not just a licence cost.

---

## 6. Security-level cost variables

| # | Item | Nature | Note |
|---|---|---|---|
| S1 | VAPT / penetration test | Annual + on major release | Usually contractually mandated |
| S2 | SOC 2 Type II | 6–9 person-months + audit fee + tooling | The big one. Ask early whether it's required |
| S3 | ISO 27001 | Overlaps S2 | Common in EU/India enterprise |
| S4 | DPDPA / GDPR compliance | DPO, DPIA, RoPA, consent notices | Platform has the *mechanics* (consent, retention, PII log, erasure); the *legal artefacts* are a separate cost |
| S5 | Data residency | Region-pinning | **Can invalidate the whole hosting quote — establish first** |
| S6 | SAST / dependency scanning | Per-seat tooling | |
| S7 | DAST | Per-target | |
| S8 | Secrets management + KMS | Key ops | Envelope encryption already implemented |
| S9 | WAF / DDoS / bot protection | Per-request tier | Not currently configured |
| S10 | Audit log retention | Storage × window | Partitioned monthly; no prune policy yet |
| S11 | Backup encryption + restore drills | Time + storage | Restore drills are usually forgotten and always audited |
| S12 | Access reviews & JML | Recurring ops | |
| S13 | Incident response + on-call | Retainer or staffed | Drives the SLA you can offer |
| S14 | Cyber insurance | Premium | Often a procurement gate |
| S15 | Sub-processor due diligence | Per vendor | Supabase, Vercel, Fly, Resend, Anthropic, OpenAI, + ASR vendor — **each must be disclosed and approved** |
| S16 | Pen-test remediation | Reserve ~20–30% of S1 | Budget it; findings are certain |
| S17 | RLS verification | Recurring | 92 policies — a regression here is a cross-tenant breach |

**Already built, and worth crediting in a security questionnaire:** RLS on 92 tables with
FORCE, `withTenantContext` plus belt-and-braces explicit `tenant_id` predicates, monthly
partitioned audit logging, a dedicated PII access log, envelope-encrypted credentials,
signed-link single-use enforcement, per-tenant AI kill switches, and consent + retention
primitives.

**Known gaps to disclose rather than paper over:** no WAF configured, no automated audit-log
prune, no SSO/SAML (Supabase Auth email/password today — see the implementation checklist),
partner portal not on git-connected CI, and 16 stale git worktrees plus an `apps/untitled
folder` in the repo that should be cleaned before any code audit.

---

## 7. Technical debt that a buyer's technical due diligence will find

Disclose these deliberately; they are all manageable, and being first to name them is worth
more than being caught.

1. **`apps/api/src/trpc/router.ts` is 30,003 lines.** Actively managed (logic is extracted to
   `lib/`), but it is the single most obvious finding in any code review.
2. **No read replica / materialized views** for analytics (§4.2).
3. **`apps/workers` now depends on `apps/api`** via a narrow subpath export, because the report
   libraries live inside the API app. Extracting them to `packages/reporting` is the clean fix.
4. **`packages/workday-client` and `packages/types` are empty stubs** (1 line each).
5. **AI pricing table is integer-rounded** (§5.1) and hardcoded in source rather than config.
6. **Repo hygiene:** 16 stale agent worktrees, an `apps/untitled folder`, and (until today)
   60 iCloud duplicate source files.

---

## 8. What to establish before quoting — in order

1. **Data residency** (A15/S5) — can invalidate everything downstream.
2. **SOC 2 / ISO requirement** (S2/S3) — the largest single swing factor.
3. **Applications per year** (A5) — the dominant AI cost driver.
4. **BYO AI keys, or AI billed by us?** — decides who owns the volatile COGS line.
5. **Notetaker in scope for v1?** (§5.3) — a new per-minute vendor bill.
6. **SSO/SAML required?** — not built today.
7. **Workday scope** — the largest unbuilt work package.
8. **Environment count** (A16) and **document retention** (A10) — the two most commonly
   under-budgeted lines.
