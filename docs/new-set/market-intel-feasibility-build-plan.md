# Market intelligence + feasibility — build plan

Date: 26 Sep 2026 · Client: Solenis GBS India (pilot), Infinity Fincorp (parallel) ·
Companion to `MARKET-INTEL-source-verification.md` (measured source data, 23 Aug) and
`SOLENIS-demo-audit-26sep.md` (§D).

This is the buying feature for both deals. Solenis today runs market pay and demand out of
Excel sheets. The pitch that wins is not "AI tells you the number"; it is **"every number
on this screen has a named source, a date and an N, and the engine tells you which level
of geography answered."** That sentence drives every design choice below.

---

## 1. What exists — verified against `main` @ dfdc1bb

| Piece | Where | State |
|---|---|---|
| `market_benchmarks` table | `packages/db/src/schema/market-benchmarks.ts` | One row per (tenant, role_title): median (paise), currency, ttf_days, availability, competitor_demand, recommended_rounds, trending_skills jsonb, **one free-text `source_note`**. RLS by tenant. |
| Benchmark procs | `router.ts` `listMarketBenchmarks`, `upsertMarketBenchmark` | Admin inline edit. No source URL, no date, no N, no multi-source. |
| Market intel page | `components/market/MarketIntelligenceView.tsx` | Benchmark table + trending-skill cards + "honesty line" that only names a source when all rows agree. |
| Feasibility engine | `apps/api/src/lib/req-feasibility.ts` (HRHEAD-02) | Claude `completeStructured` with JD skills + comp band + **the single matched benchmark row** (fuzzy `matchBenchmarkTitle`) or explicit no-benchmark mode. Output `feasibilityAssessmentSchema`: skillsFit, expCompFit, difficulty, recommendedSalaryAdjustmentPct, recommendation, supplyNote. Cached in `requisition_feasibility` with model + prompt_version. Kill-switch via `req_feasibility` AI feature key. |
| Feasibility page | `components/market/FeasibilityView.tsx` | Per-req cards, generate/regenerate. |
| Comp desk | `components/comp/CompAnalysisPanel.tsx` | Shows "Curated benchmarks" next to current / expected / band. |
| Location data | `positions.primary_location` (free text), `positions.location_type` | No structured country/region/city anywhere. |
| Solenis rows | `seed-solenis-demo.ts` `BENCHMARKS` | 8 GBS titles, **invented medians**, note "Curated benchmark — Solenis GBS pilot, update quarterly". |
| Source verification | `MARKET-INTEL-source-verification.md` | Adzuna India: salary disclosure ~6 % (unusable), demand counts city-resolvable and large (usable). Guides (Michael Page / TeamLease / Randstad) are the salary source. Levels.fyi and Jobicy dropped. |

Nothing below the "Source verification" row is wired into code. There is no Adzuna client,
no source registry, no upload path, no geography model.

## 2. Product shape — split the feature by what each source can prove

```
                    ┌──────────────────────────────────────────────────────┐
                    │  market_sources (per tenant)                          │
                    │  kind: published_guide | licensed_survey | client_file │
                    │        | job_board_api | first_party_offers            │
                    │  name, publisher, url, published_on, licence_note      │
                    └───────────────┬──────────────────────────────────────┘
                                    │ 1:N
                    ┌───────────────▼──────────────────────────────────────┐
                    │  market_observations                                  │
                    │  source_id, canonical_title, geo_level (country|      │
                    │  region|city), geo_code, metric (median_salary |      │
                    │  p25 | p75 | ttf_days | postings_count), value,       │
                    │  currency, sample_n, observed_on                      │
                    └───────────────┬──────────────────────────────────────┘
                                    │ resolved by
                    ┌───────────────▼──────────────────────────────────────┐
                    │  resolveMarket(tenant, tenantTitle, geo)              │
                    │  1. tenantTitle → canonical_title (alias table +      │
                    │     fuzzy, with the suggestion surfaced to the user)  │
                    │  2. city → region → country fallback per metric       │
                    │  3. returns EVERY source's figure as-is + the level   │
                    │     that answered + N — never a blended number        │
                    └───────────────┬──────────────────────────────────────┘
                                    │ consumed by
        ┌───────────────────────────┼─────────────────────────────┐
        ▼                           ▼                             ▼
  Market intel page          Feasibility (Claude)            Comp desk panel
  (sources side by side)     (prompt cites each source       (same resolver,
                              + level + N; no invention)      same provenance)
```

**Salary** = curated, attributed, annual cadence: published guides, the client's licensed
survey (uploaded by them, licence theirs), their Excel, and HireOps first-party offers as
the pilot accrues. **Demand / availability** = live, city-level, nightly from Adzuna.
Both flow through one resolver so the feasibility prompt and the comp desk see the same
provenance the HR head sees on the market page.

## 3. Data model (migration 0120, additive; `market_benchmarks` stays until MI-6)

- `market_sources` — id, tenant_id, kind (enum above), name, publisher, url, published_on,
  licence_note, uploaded_document_id (nullable → `documents`), created_by, created_at. RLS
  by tenant. Unique (tenant_id, name, published_on).
- `market_title_aliases` — tenant_id, tenant_title, canonical_title, confidence (0–1),
  confirmed_by (nullable). The "suggest the public title" feature is this table plus the
  existing fuzzy matcher; a confirmed alias is deterministic thereafter.
- `market_observations` — as drawn above. `geo_level` enum `country|region|city`,
  `geo_code` text (`IN`, `IN-TS`, `IN-TS-HYD`), metric enum, value bigint (minor units
  for money, integer for counts/days), sample_n int nullable, observed_on date. Index on
  (tenant_id, canonical_title, metric, geo_level).
- `market_demand_snapshots` — the nightly Adzuna pull: tenant_id, canonical_title,
  geo_level, geo_code, postings_count, pulled_at. Kept 90 days (retention sweep reuses the
  existing purge job pattern).
- `positions.primary_location` gets a structured sibling: `positions.geo_code` text,
  nullable, set from a city picker (Hyderabad, Bengaluru, Pune, Chennai, Mumbai, Gurgaon,
  NCR for the India-only pilot). Free text stays for display.
- `requisition_feasibility` gains `evidence jsonb` — the resolver output the prompt was
  built from, so the card can show "sources used" without re-resolving.

## 4. Build sequence

Effort assumes one Opus executor per ticket with the orchestrator reviewing; gates as usual.

### Slice 0 — demo-safe (before 8 Oct) · ~1 day

- **MI-0a Citations on the existing table.** Add `source_url`, `source_published_on`,
  `sample_n` to `market_benchmarks` (migration), admin form fields, and render each row's
  note as a clickable citation with date and N. The honesty header becomes "N sources".
  *Content task for a human:* replace the 8 invented Solenis medians with figures from
  named 2026 India guides (Michael Page, TeamLease, Randstad) and fill the three fields.
  If a title has no published figure, leave the median null and let the row say so — the
  empty cell is more credible than an invented one.
- **MI-0b Feasibility prompt cites the row.** `buildRequisitionFeasibilityPrompt` includes
  source name + date + N and is told "do not infer a market figure when none is supplied".
  Prompt version bump to `hrhead-02-v2`. The card shows the citation under the verdict.

### Slice 1 — the source registry (pilot week 1–2) · ~4 days

- **MI-1 Migration 0120 + schemas** (§3) with api-types zod, RLS lint green.
- **MI-2 Sources admin.** `/admin/market-sources`: list / add published guide (name, URL,
  date, publisher) / upload licensed survey or Excel (reuse `startInterviewMediaUpload`
  signed-PUT pattern into `candidate-uploads`-style private bucket `market-sources`) /
  licence note mandatory on `licensed_survey`. PII-free by construction; still audit-logged.
- **MI-3 Observation ingest.** Two paths: (a) CSV template download + upload for guides and
  client files (columns: canonical_title, geo_level, geo_code, metric, value, currency,
  sample_n, observed_on) with row-level validation and a preview before commit; (b) manual
  single-row entry. No PDF parsing in the pilot — the guides are tables a person keys once
  a year.
- **MI-4 Migrate `market_benchmarks` → observations.** One-off script per tenant; the old
  table becomes a read-through view until MI-6 removes it.

### Slice 2 — the resolver + title suggestion (pilot week 2–3) · ~4 days

- **MI-5 `resolveMarket()`** in `apps/api/src/lib/market-resolver.ts`: pure, tested with
  fixtures. Input (tenant, tenantTitle, geo_code, metrics[]). Steps: alias lookup → fuzzy
  (`matchBenchmarkTitle` generalised, returns top-3 with confidence) → per-metric fallback
  city → region → country → per-source figures with `answeredAt` level and `sample_n`.
  Output type `MarketResolution` in api-types. Never blends; the UI may compute a range
  across sources but labels it as such.
- **MI-6 Market intel page v2.** Rows = tenant titles; each row expands to the sources
  side-by-side (name · date · N · level that answered · figure). Canonical-title
  suggestion chip with confirm/override → writes `market_title_aliases`. Coverage badge per
  row (n sources / none). Old benchmark table removed.
- **MI-7 Feasibility v2 + comp desk.** Both consume `MarketResolution`; the prompt lists
  each source with provenance; `evidence jsonb` persisted; card shows "based on 3 sources,
  city-level for demand, country-level for pay (no city data)". Prompt version `hrhead-02-v3`.

### Slice 3 — live demand (pilot week 3–4) · ~3 days

- **MI-8 Adzuna client** in `packages/market-clients/adzuna.ts` with a `local` fixture mode
  (same discipline as `ai-client` / `asr`). Credentials per tenant in
  `integration_credentials` (existing KEK-wrapped table) — the MindsSparc app id is the
  fallback for tenants without their own.
- **MI-9 Nightly demand drain** in `apps/workers/src/lib/market-demand-drain.ts` on the
  existing `scheduler.ts`: for each tenant title × pilot city list, pull counts, write
  `market_demand_snapshots`, derive `availability` / `competitor_demand` bands from
  configurable thresholds (tenant setting, defaults from the 23 Aug measurements). Idempotent
  per (title, geo, day). Failure = stale badge on the page, never a crash.
- **MI-10 Demand on the page + in feasibility.** Trend sparkline (last 30 pulls) per row;
  the feasibility prompt receives counts, not adjectives.

### Slice 4 — first-party signal (post-pilot)

- **MI-11 Offers as a source.** Accepted offers per canonical title × city feed
  `market_observations` under a `first_party_offers` source with N and date; shown only
  when N ≥ 5 (tenant setting). This is the flywheel line in the sales deck; it must be
  honest about N.

## 5. Governance stance — and why it is the differentiator

- **Provenance is mandatory.** No observation without a source; no source without a date.
  The UI never shows a number it cannot attribute.
- **No blending.** The engine reports each source as-is. Any range or midpoint is labelled
  "across N sources" and is computed in the UI, not stored.
- **Level honesty.** Every figure says which geography level answered. "Country-level, N=53"
  is a feature, not an apology.
- **Licence boundary.** Licensed surveys are uploaded by the client under their licence;
  the platform stores the licence note and restricts the source to that tenant. Ask
  Solenis (Tuesday) whether their Mercer / AON / WTW terms permit loading into a
  vendor-hosted platform; if not, the survey stays a link, not an upload.
- **AI never invents a market number.** Feasibility reasons over supplied figures only and
  is told so in the prompt. Kill-switch already exists (`req_feasibility`).
- **Data residency.** Observations are not PII, but the Solenis Supabase project is in
  Singapore; flip to Mumbai before pilot data accrues (see audit §G).

## 6. Cost shape

- Adzuna: free tier is enough for the pilot (8–20 titles × 7 cities × 1 pull/night). Paid
  tier only if >1 000 calls/day; price on the commercial sheet as pass-through.
- Claude: feasibility calls are unchanged in count; prompt grows by ~1–2 k tokens per
  source. Already metered in `ai_usage_logs`.
- Storage: negligible (CSV/XLSX uploads).
- Human: one annual keying of guide tables per tenant (~half a day). Offer this as part of
  the managed service.

## 7. Decisions needed before dispatch

1. Slice 0 goes before the demo; confirm a human will pull the real guide figures by Mon 29
   Sep (registration needed for Michael Page; TeamLease download).
2. Pilot city list for India: Hyderabad, Bengaluru, Pune, Chennai, Mumbai, Gurgaon/NCR —
   confirm with Solenis (they are Hyderabad-only today).
3. Canonical title taxonomy: start from the guides' own titles (they are what the market
   publishes), not NCO-2015; keep NCO as an optional code column.
4. Whether the demand thresholds (low / medium / high) are tenant-editable in the pilot or
   fixed from the 23 Aug measurements. Recommend editable with defaults.
5. Infinity Fincorp: same schema, different guides (BFSI) — no code divergence expected.

## 8. Questions for Solenis on Tuesday

- Which published guides do they trust today, and which licensed surveys do they hold?
- Does their survey licence permit loading into a vendor platform?
- Their current Excel: columns and cadence — this becomes the CSV template in MI-3.
- Hyderabad only, or do they benchmark against Bengaluru / Pune when they lose candidates?
- Who owns the annual refresh on their side?
