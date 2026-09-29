# Market intelligence — platform-owned sources, not just the client's

29 Sep 2026. Solenis asked that the **platform itself** bring market sources, not only hold
theirs. This extends `market-intel-feasibility-build-plan.md` (the client-source registry,
resolver and Adzuna demand) with a platform data layer. Source findings behind it:
`MARKET-INTEL-source-verification.md` (23 Aug).

## The principle (unchanged)

Every figure on screen names its **source, publication date, sample size and geography
level**. Sources are shown side by side, never blended into one invented number. The AI
never produces a market figure — it reads the cited figures and explains what they mean for a
requisition, citing which source it used. No source → the screen says "no published figure".

## Four tiers of source

| Tier | What | Who sees it | Examples | Role |
|---|---|---|---|---|
| **1. Platform-licensed** | Data HireOps licenses and ships to every tenant | All tenants (per licence) | Lightcast (postings + compensation APIs, 165+ countries); India/GCC specialists such as PlugScale; Ravio (tech-heavy) | Salary + demand, refreshed by the vendor |
| **2. Public, cited** | Published guides and open data, keyed and cited | All tenants | Michael Page India Salary Guide 2026, TeamLease, Randstad; Adzuna India job-posting counts; MoSPI PLFS wage data (macro context only) | Salary (annual), live demand (daily) |
| **3. Client-private** | The client's own licensed surveys and pricing sheets | That tenant only | Solenis's Aon / Mercer / WTW data (if licence permits), internal Excel | Primary for that client |
| **4. HireOps network** | Aggregated, anonymised accepted offers across consenting clients | All contributing tenants | Shown only when ≥ 5 employers and N ≥ 20 per cell | The long-term moat |

Measured facts that shape this: Indian job ads disclose pay in only ~6 % of postings, so
job-board data (Adzuna, Naukri) is used for **demand**, not salary. Salary comes from surveys,
guides, licensed vendors and, later, the network.

## How the platform pulls it

- **Source registry** — each source has a kind, publisher, URL, publication date, licence note
  and **visibility** (platform-wide vs one tenant). Nothing enters without a registry entry.
- **Connectors** (APIs, nightly/weekly): licensed vendor API, Adzuna demand. Per-source client
  with a local fixture mode, credentials in the existing encrypted `integration_credentials`,
  failures show a "stale since …" badge, never a crash.
- **File ingest** (guides, client sheets): spreadsheet template upload with a row-level preview.
  For PDF guides, AI may *read* the table to save keying, but **a person verifies every row
  against the page before it is published**, and the figure cites the page — AI speeds up entry;
  it is never the source.
- **Role taxonomy** — the client's titles map to canonical titles (with NCO-2015 / vendor codes);
  a suggested match is confirmed by a person once, then reused.
- **Geography** — city → region → country fallback; each figure says which level answered.
- **Resolver** — for a requisition (title × city), returns every source's figure as-is with its
  provenance; the page and the feasibility check both use it.

## Build sequence

| Phase | When | Effort | Delivers |
|---|---|---|---|
| **0. Demo-safe** | before 8 Oct | ~1–2 d (mostly content) | Placeholders replaced with cited figures from a named 2026 guide and/or Solenis's sheet; each row shows source · date · N; "no published figure" where none exists |
| **1. Source registry + ingest** | pilot wk 1–2 | ~4 d | Sources admin; template upload with preview; platform vs tenant visibility |
| **2. Resolver + side-by-side view** | pilot wk 2–3 | ~4 d | Every source per role, geography fallback, feasibility and comp desk cite sources |
| **3. Live demand** | pilot wk 3–4 | ~3 d | Nightly Adzuna posting counts by city, trend per role |
| **4. Licensed data partner** | month 2 | ~5–7 d build + commercial | Trial 1–2 vendors on Solenis's 8 roles (coverage for GBS finance roles in Hyderabad is the test), sign the one that covers them, connector ships platform-wide |
| **5. HireOps network benchmark** | post-pilot, multi-client | ~5 d + contract terms | Anonymised offer aggregates with minimum-N and minimum-employer thresholds, opt-in in the client contract |

## Governance

- Provenance mandatory; no blending; geography level always shown.
- Licence registry: each source's licence note decides visibility; client-licensed data never
  leaves that tenant.
- AI never invents a figure; feasibility prompt receives only cited figures and is told so.
- Network data only with contractual opt-in and thresholds that prevent identifying any
  employer or person.

## Open decisions
1. Which licensed vendor to trial first (coverage of GBS finance roles in Indian cities is the
   deciding test, not brand).
2. Commercial model for platform-licensed data (bundled vs add-on per tenant).
3. Whether published-guide figures can be keyed at scale under each publisher's terms, or only
   cited with a link.
