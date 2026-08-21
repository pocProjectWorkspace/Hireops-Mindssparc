# HireOps — AI usage inventory & cost model

**Date:** 21 August 2026 · **Basis:** `main` @ `28944fe`, plus 1,486 real rows in `ai_usage_logs` on staging.
**Purpose:** identify every external AI API call the platform makes, and cost it across usage buckets.

---

## 1. Method — and why it isn't guesswork

Three steps, in this order. The order matters: doing it the other way round produces a list of
*features* rather than a list of *API calls*, and those are not the same thing.

1. **Inventory from the call sites outward.** Start at the two functions that actually reach an
   external provider — `complete()` and `completeStructured()` in `packages/ai-client/src/{anthropic,openai}.ts`
   — and trace every caller. A feature-name list built top-down misses calls that share a key and
   invents calls for features that turn out not to be AI at all. Both happened here (§3, §4).
2. **Measure unit cost, don't estimate it.** Every call already writes `input_tokens`,
   `output_tokens`, `cost_micros`, `model` and `feature` to `ai_usage_logs`. So per-call cost is a
   query, not an assumption. **Only volume needs assuming.**
3. **Bucket by volume driver, not by product area.** What matters commercially is what multiplies:
   applications, requisitions, interviews, offers, users. A "JD tools" bucket would mix a
   per-requisition cost with a per-user one and price neither correctly.

**Reproduce the measurement:**

```sql
SELECT feature, count(*) AS calls,
       round(avg(input_tokens))  AS avg_in,
       round(avg(output_tokens)) AS avg_out,
       round(avg(cost_micros))   AS avg_micros
FROM ai_usage_logs
WHERE cost_micros > 0            -- excludes local/seeded fakes; see §8
GROUP BY feature ORDER BY calls DESC;
```

---

## 2. Complete inventory — every external AI call

**14 distinct AI call sites.** 12 are governed by a feature key (kill switch, model allowlist,
BYO key, cost logging, admin UI). One is live but ungoverned. One is built but not yet wired.

| # | Call (usage feature) | Governance key | Trigger | Volume driver |
|---|---|---|---|---|
| 1 | `resume_parse` | **none — see §4.1** | Automatic on every CV submitted | **Application** |
| 2 | `ai_scoring` | `ai_scoring` | Automatic, via `ai-score-drain` worker | **Application** |
| 3 | `jd_generation` | `jd_generation` | Recruiter clicks Generate in the req wizard | Requisition |
| 4 | `jd_bias_review` | `jd_bias_review` | Recruiter clicks "Review with AI" | Requisition |
| 5 | `req_feasibility` | `req_feasibility` | Explicit Generate/Refresh on the Feasibility page | Requisition |
| 6 | `req_revision` | `req_revision` | Requisition-owner revision suggestions | Requisition |
| 7 | `interview_prep` | `interview_prep` | Explicit Generate on the panel brief | Interview |
| 8 | `feedback_summary` | `feedback_summary` | Summarises panel scorecards | Interview |
| 9 | `comp_recommendation` | `comp_recommendation` | Explicit "Generate rationale" on the offer desk | Offer |
| 10 | `iris_intent` | `iris_assistant` | Every Iris turn (intent resolution) | User session |
| 11 | `iris_help` | **unattributed — see §4.2** | Iris help/guide mode | User session |
| 12 | `iris_message_draft` | `iris_assistant` | Iris drafting a candidate message | User session |
| 13 | `agent_draft_message` | `agent_drafts` | Agent drafts a candidate follow-up | User session |
| 14 | `recruiter_brief` | `recruiter_brief` | Recruiter briefing generation | User session |
| — | `interview_notes` | `interview_notes` | **Built, not yet wired** — pipeline is ticket N3 | Recorded interview |

**Providers:** Anthropic and OpenAI, per tenant, with envelope-encrypted BYO keys. Default models
are `claude-sonnet-4-6` (Anthropic) and `gpt-5` (OpenAI). Default output ceiling is 4,096 tokens;
the resume parser sets 4,000 explicitly.

**Where they live:** prompt builders in `apps/api/src/lib/*` (`jd-generation.ts`, `req-feasibility.ts`,
`comp-recommendation.ts`, `feedback-summary.ts`, `interview-prep.ts`, `req-revision.ts`,
`jd-bias-review.ts`, `recruiter-brief.ts`, `iris/*`), with the model calls inline in
`apps/api/src/trpc/router.ts`; the two automatic ones in `apps/workers/src/lib/ai-score-drain.ts`
and `packages/ai-client/src/parsers/resume.ts`.

---

## 3. What is **not** an AI call

Worth stating explicitly, because it is commonly assumed to be:

- **Market intelligence / market benchmarks.** Reads the curated `market_benchmarks` table,
  populated by `db:seed:benchmarks`. **No model call, no token cost.** The *feasibility* and
  *comp rationale* features (#5, #9) consume those benchmarks as prompt input — so the
  intelligence is curated data that AI reasons over, not AI-generated data.
- **AI scoring weights, bias lexicon, SLA thresholds** — all deterministic configuration.
- **Reports, analytics, the board pack** — pure SQL. Nothing in the reporting module calls a model.
- **Duplicate detection / knockout rules** — deterministic.

---

## 4. Two governance gaps found during the inventory

### 4.1 `resume_parse` is live, billable, and has no kill switch

`parseResume` is called on **every** CV submitted — both the candidate apply path
(`router.ts:4079`) and partner submission (`router.ts:3274`). It writes an `ai_usage_logs` row with
feature `resume_parse`, so it **is** cost-logged. But:

- it is **not** in `AI_FEATURE_KEYS` (12 keys, `resume_parse` is not among them);
- `packages/ai-client/src/parsers/resume.ts` performs **no** `resolveTenantAiSettings` check before
  calling the model — unlike `ai-score-drain.ts`, which gates on `aiSettings.ai_scoring.enabled`.

**Consequence:** a tenant cannot turn CV parsing off, and it does not appear in the admin AI
settings surface. It is also (§6) the **single most expensive call in the platform** and sits on
the highest-volume path — **76% of all per-application AI cost**.

This is the most commercially significant finding in this document. Recommendation: add a
`resume_parse` feature key. It is a small change that follows the existing 12-key precedent
exactly, and it converts the largest AI cost line from ungovernable to switchable.

### 4.2 `iris_help` is logged but not attributed to any key

`AI_FEATURE_META.iris_assistant.usageFeatures` lists `["iris_intent", "iris_message_draft"]`.
Production logs contain a third string, `iris_help`. Since the admin cost surface sums spend by
`usageFeatures`, **Iris's reported spend currently excludes help-mode calls**. One-line fix: add
`"iris_help"` to that array. (Separately: `iris_message_draft` has zero logged calls — that path
appears unexercised, worth confirming rather than assuming it is broken.)

---

## 5. The five cost buckets

| Bucket | Contains | Multiplies with |
|---|---|---|
| **A — Per application** *(automatic)* | `resume_parse`, `ai_scoring` | Applications received |
| **B — Per requisition** *(on demand)* | `jd_generation`, `jd_bias_review`, `req_feasibility`, `req_revision` | Requisitions opened |
| **C — Per interview** *(on demand)* | `interview_prep`, `feedback_summary`, *(future `interview_notes`)* | Interviews held |
| **D — Per offer** *(on demand)* | `comp_recommendation` | Offers made |
| **E — Per user** *(conversational)* | `iris_intent`, `iris_help`, `iris_message_draft`, `agent_draft_message`, `recruiter_brief` | Active users × engagement |

**Bucket A is the only one that fires without a human deciding to.** Every other bucket requires
someone to click something, which makes B–E soft-capped by user behaviour and A hard-driven by
applicant volume. That distinction is the whole commercial story.

---

## 6. Measured unit costs

From `ai_usage_logs`, real calls only (`cost_micros > 0`):

| Usage feature | Real calls | Avg in | Avg out | **Avg USD/call** |
|---|---:|---:|---:|---:|
| `resume_parse` | 6 | 3,580 | 1,386 | **$0.03153** |
| `recruiter_brief` | 4 | 1,712 | 373 | $0.01072 |
| `ai_scoring` | 230 | 1,256 | 414 | $0.00997 |
| `jd_generation` | 111 | 681 | 372 | $0.00951 |
| `req_feasibility` | 143 | 743 | 266 | $0.00950 |
| `iris_help` | 5 | 2,073 | 161 | $0.00864 |
| `interview_prep` | 89 | 927 | 281 | $0.00652 |
| `iris_intent` | 10 | 1,435 | 105 | $0.00587 |
| `jd_bias_review` | 52 | 511 | 205 | $0.00511 |
| `feedback_summary` | 5 | 995 | 90 | $0.00433 |
| `comp_recommendation` | 105 | 517 | 94 | $0.00427 |
| `req_revision` | 125 | 480 | 120 | $0.00390 |
| `agent_draft_message` | 281 | 354 | 108 | $0.00268 |

**Derived bucket rates:**

| | Rate |
|---|---|
| A — per application | **$0.0415** (resume_parse $0.0315 + ai_scoring $0.0100) |
| B — per requisition | $0.0261 (JD gen + bias review + feasibility + 0.5× revision) |
| C — per interview | $0.0109 (prep + feedback summary) |
| D — per offer | $0.0043 |
| E — per user / year | $1.71 (150 Iris turns + 50 help + 100 agent drafts + 12 briefs) |
| *interview_notes (future)* | *~$0.0165 per recorded interview (≈9k transcript in, ~700 out)* |

---

## 7. Cost model

Volume assumptions are illustrative; replace with the client's actuals from the implementation
checklist (§3 of the commercial sizing doc).

| Profile | Reqs/yr | Applications/yr | Interviews/yr | Offers/yr | Users | **A** | **B** | **C** | **D** | **E** | **Annual** | **Monthly** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Pilot | 25 | 1,500 | 225 | 30 | 3 | $62 | $1 | $2 | $0 | $5 | **$71** | **$6** |
| Small | 100 | 8,000 | 1,200 | 120 | 8 | $332 | $3 | $13 | $1 | $14 | **$362** | **$30** |
| Mid-market | 400 | 30,000 | 4,500 | 480 | 25 | $1,245 | $10 | $49 | $2 | $43 | **$1,349** | **$112** |
| Large | 1,000 | 80,000 | 12,000 | 1,200 | 60 | $3,320 | $26 | $130 | $5 | $103 | **$3,584** | **$299** |
| Enterprise | 2,500 | 250,000 | 37,500 | 3,000 | 150 | $10,375 | $65 | $407 | $13 | $256 | **$11,116** | **$926** |

Adding the notetaker at 50% recording consent adds roughly **$4/mo** (Mid-market) to **$26/mo**
(Enterprise) in *LLM* cost — but see §9 on ASR, which is the larger notetaker line and is **not**
in this model.

### What the shape tells you

- **Bucket A is 92% of AI cost** at mid-market, and its share *grows* with volume because every
  other bucket is capped by human behaviour.
- **AI is a modest COGS line.** Even at 250,000 applications/year, the model cost is under
  $1,000/month. AI pricing should not be the anxiety in this deal; per-minute ASR (§9) and
  infrastructure are larger.
- **Price AI on application volume, not per seat.** A 25-user tenant processing 80,000
  applications costs 10× a 25-user tenant processing 8,000. Seat-based AI pricing loses money on
  exactly the high-volume recruiters you most want.
- **Fixing §4.1 would let a cost-sensitive tenant halve bucket A** by disabling parsing (accepting
  manual data entry) — currently impossible.

---

## 8. Cost controls that already exist

Worth selling, because they are real and built:

- **Per-feature kill switches** on 12 of 14 calls (see §4.1 for the exception).
- **Model allowlist per tenant** — routing a feature to Haiku instead of Sonnet cuts its cost
  roughly 4×.
- **BYO API keys**, envelope-encrypted — moves AI spend entirely onto the client's own provider
  bill and removes it from our COGS.
- **`ai_usage_logs`** — full cost ledger by tenant, feature, model, actor, latency, success.
- **Monthly budget with threshold alerts** and a linear month-end projection.
- **PII masking** before model calls, where enabled.

**State it accurately:** the budget feature **alerts**; it does **not** hard-block calls at 100%.
A blocking cap was deliberately deferred (T5.1b). Do not imply a spend cap exists.

---

## 9. Caveats — read before quoting

1. **`resume_parse` rests on 6 real samples.** 320 of its 326 logged rows had `cost_micros = 0`
   (local-mode or seeded fakes) and were excluded. The naive average including them was $0.00058 —
   **54× too low**, and it would have understated the platform's dominant cost line by 4×. The
   $0.0315 figure is directionally sound (a CV genuinely is ~3,600 input tokens) but should be
   re-derived once real production traffic accumulates.
2. **The rate table rounds.** `packages/ai-client/src/pricing.ts` stores integer micros-per-token,
   so Haiku input ($0.80/M) logs at $1.00/M and gpt-5 input ($1.25/M) at $1.00/M. `ai_usage_logs`
   is indicative, not invoice-accurate. Fix to fractional precision before billing AI as a
   pass-through.
3. **Unknown models fall back silently** to a default rate with only a `console.warn`. A newly
   allowlisted model bills at a stand-in rate until someone updates the table.
4. **ASR is not in this model.** The notetaker's speech-to-text bills **per meeting-minute
   regardless of BYO LLM key**, and `recordAIUsage` captures only the LLM half. At scale this will
   exceed every number in §7. It needs its own cost row before the notetaker goes live.
5. **Volumes are illustrative.** Only the unit costs are measured.
6. **Staging ≠ production mix.** Feature *mix* here reflects testing, not real recruiter behaviour.
   Unit costs per call transfer; call *frequencies* do not.

---

## 10. Recommended next actions

| Priority | Action | Effort |
|---|---|---|
| 1 | Add a `resume_parse` feature key (§4.1) — governs the largest cost line | Small |
| 2 | Add `iris_help` to `iris_assistant.usageFeatures` (§4.2) — fixes under-reported Iris spend | One line |
| 3 | Move `pricing.ts` to fractional rates (§9.2) | Small |
| 4 | Add an ASR cost row before the notetaker ships (§9.4) | Medium |
| 5 | Re-derive `resume_parse` unit cost once real traffic accumulates (§9.1) | Query |
| 6 | Confirm whether `iris_message_draft` is genuinely unused (§4.2) | Investigation |
