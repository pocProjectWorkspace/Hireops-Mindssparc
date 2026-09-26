# Solenis demo audit — 26 Sep 2026

Prepared for the 3-hour Solenis India working session (Tue 29 Sep) that finalises the
8 Oct demo to US senior leadership. Everything below was verified against the code on
`main` @ `dfdc1bb`, the live Solenis environment (Vercel `solenis-portal`, Railway
`welcoming-sparkle`, Supabase `wbjwudtyyblvyirbkrsp`) and the Solenis questionnaire in
`public/solenis demo data/`.

Legend: **[BLOCKER]** visible on stage · **[ANSWER]** they will ask, know the answer ·
**[HYGIENE]** fix when convenient.

---

## A. Kyndryl leaks — live-confirmed

| # | Where it shows | Root cause | Fix | Effort |
|---|---|---|---|---|
| A1 **[BLOCKER]** | Every public apply link: `solenis.hireops-ai.com/t/kyndryl-poc/apply/<role>` (shown verbatim on the requisition detail page, copied into postings) | Tenant row slug is still `kyndryl-poc` on the Solenis DB; URL is `/t/{tenants.slug}/apply/{publicSlug}` | Rename slug to `solenis`: `UPDATE tenants SET slug`, `UPDATE auth.users SET raw_user_meta_data.tenant_slug` for every member, set `NEXT_PUBLIC_DEFAULT_TENANT_SLUG=solenis` on `solenis-portal`, update `TENANT_SLUG` in `seed-solenis-demo.ts` + `seed-solenis-partner-login.ts`. Everyone re-logs in once. | 1 h |
| A2 **[BLOCKER]** | Partner portal (partners-solenis.hireops-ai.com): login page "Kyndryl employees and candidates sign in elsewhere", reqs list, req detail, submissions, submit form (consent + "Kyndryl's MSA Section 4.2"), commercials, not-a-partner page — ~22 hardcoded strings | `partnerGetMe` returns `orgName` (Hudson) but no hiring-tenant name; UI hardcodes "Kyndryl" | Add `tenantDisplayName` to `partnerGetMe` (join `tenants`), thread it through the layout, replace every literal | 2 h |
| A3 **[BLOCKER]** | Admin → Email templates → preview shows "Kyndryl" / "Senior Backend Engineer" / "Priya Sharma" | `EMAIL_TEMPLATE_SAMPLE_DATA` in `packages/email-templates/src/catalog.ts` | Swap sample data to Solenis-shaped values (GBS role titles, tenant display name) | 30 min |
| A4 **[HYGIENE]** | README, package.json description, ~30 code comments, `docs/architecture.md` | History | Leave; not on stage | — |

## B. AI interview — built, but not reachable from the product

Verified state of N4 on `main`:

- API: `generateAiInterviewQuestions`, `approveAiInterviewQuestions`, `issueAiInterviewSession`,
  `getAiInterviewSession` exist and are tested. Candidate page `/interviews/ai/[token]` works
  (disclosure, consent, one question at a time, audio or typed answers, "Round complete").
- **No recruiter UI at all.** The interview-mode selector offers only Video / On-site / Phone;
  `ai_async` cannot be chosen. Nothing calls generate / approve / issue. The link is returned
  once in the API response and there is **no email template** for it.
- **N4.4 evidence report and N4.5 review surface were never built** (`ai_interview_evidence`
  appears nowhere). After a candidate submits, the recruiter gets a transcript at best.

| # | Item | Fix | Effort |
|---|---|---|---|
| B1 **[BLOCKER]** | Cannot show the feature end-to-end | Add "AI first round (async)" to the mode selector; on the interview row add a card: Generate questions → show them with rubric keys → Approve → Issue link (copy button + expiry). Reuse the four existing procs, no new API. | 1 day |
| B2 **[ANSWER]** | "What does the recruiter get back?" | Transcript + AI notes only today. Evidence report (per-rubric covered/not-covered with verbatim quotes, knockout verification, no score) is designed and is the first pilot deliverable. Say that plainly. | 1–2 days, post-Tuesday |
| B3 | Fallback if B1 slips | I can issue one session by script the morning of the demo and the presenter opens the candidate link; that shows only the candidate side. | 30 min |

## C. Transcription / notetaker — will fail on the Solenis environment today

- The Solenis `workers` service has **no `ASSEMBLYAI_API_KEY`, no `DEEPGRAM_API_KEY`, no
  `ASR_CLIENT_MODE`**. The ASR factory defaults to AssemblyAI and throws without a key, so
  every uploaded recording will sit in `pending`/`failed`.
- Consent is only captured when the candidate confirms an interview via the emailed link.
  Resend is in test mode: only `digitalfuturity@outlook.com` receives mail. The Solenis seed
  contains **zero** consented recordings.

| # | Fix | Effort |
|---|---|---|
| C1 **[BLOCKER]** | Set `ASSEMBLYAI_API_KEY` (or `ASR_PROVIDER=deepgram` + key) on Solenis workers, redeploy, confirm one transcript lands | 30 min + key procurement |
| C2 **[BLOCKER]** | Pre-stage one Solenis interview (a GBS role, candidate email = demo inbox): confirm + consent, recruiter toggles recording, upload a 3–5 min mock panel recording, let it transcribe and generate AI notes **before** the meeting. On stage, open it finished; optionally upload a second one live. | 1 h once C1 is in |
| C3 **[ANSWER]** | Retention: per-tenant audio retention days is configurable (Admin → Retention policy). Solenis said data must stay with local leadership — that setting plus RLS is the answer. | — |

## D. Market intelligence — the buying feature; be precise about what is live

What exists: a per-tenant `market_benchmarks` table (median, TTF, availability, demand,
rounds, trending skills, **one free-text `source_note` per row**), admin inline edit, and a
Claude-written feasibility verdict per requisition that uses the matching row + JD + comp band.
The 8 Solenis rows carry the note "Curated benchmark — Solenis GBS pilot, update quarterly"
and **invented medians**.

What they asked for (23 Aug call) and is **not** in code: multiple sources per role shown
as-is; upload a file / add a link as a source; canonical public title suggestion;
country → region → city resolution reporting which level answered and the N; live demand
counts (Adzuna was verified viable on 23 Aug for demand, not salary, and was never wired in).

| # | Item | Fix | Effort |
|---|---|---|---|
| D1 **[BLOCKER]** | Rows have no source link; a comp head will ask "where is this from?" | Add `source_url`, `source_published_on`, `sample_size` to `market_benchmarks` (migration + admin form + view renders a clickable citation per row). Replace the 8 invented medians with figures from named 2026 India guides (Michael Page / TeamLease / Randstad) — a human must pull those. | ½ day code + content |
| D2 **[ANSWER]** | "Can we add our own survey / a link?" | With D1, a link per row is possible. File upload of a licensed survey is pilot scope; confirm their Mercer/AON/WTW licence permits loading into a vendor platform. | — |
| D3 **[ANSWER]** | "Is it AI?" | The verdict is Claude, grounded in the row + JD + band. The numbers are curated, not generated. Do not narrate the table as AI-derived. | — |
| D4 **[ANSWER]** | Engine (three-layer resolution, live demand) | Pilot deliverable; the source-verification doc is the evidence that it is designed against measured data. | — |

## E. Vocabulary mismatches against Solenis's own process

| # | Item | Detail | Fix | Effort |
|---|---|---|---|---|
| E1 **[BLOCKER]** | "Technical interview" / "Tech interview" chips on finance and SAP roles | Stage `tech_interview` labels are hardcoded in 7 portal files (`candidate-format.ts`, `Chips.tsx`, SLA thresholds, HR docs, HR cases, case audit, candidate fields) | Rename label to "Panel interview" everywhere (enum key unchanged) | 1 h |
| E2 **[ANSWER]** | Their Workday stages: Application Received – Screened – Manager Review – Interview – Offer Release – Ready For Hire – Hire | Ours: Applied – Screening – Under review – Shortlisted – Panel interview – HR round – Offer prepared – Offer accepted. Close enough; per-tenant stage labels are a pilot config item. | — |
| E3 **[ANSWER]** | Approval chain: they have 5 levels (HR, HM, skip, GSS leader, global function lead) | T1.3 approval routing is single-step; the seeded matrix names their chain but cannot sequence it. Say "multi-level routing is a pilot config item". | — |
| E4 **[ANSWER]** | 10% internal hires | `application_source` enum has no `internal_mobility`; seeded as `talent_pool`. | — |

## F. Reports they named vs what exists

Solenis (Sneha) listed: pipeline summary, time-to-hire, cost-per-hire, >30% hike rationale,
source mix, offer acceptance, ageing requisitions, diversity / diverse-slate %, agency
performance, assessment (Mettl/Mercer) deviation cases.

| Asked | Status | What to say |
|---|---|---|
| Pipeline, TTH, source mix, offer acceptance, ageing reqs, agency scorecard, fill rate | **Live** (Reports hub + HR analytics + Metrics) | Show them |
| Cost-per-hire | Tile is honestly labelled **agency cost, not CPH** | Blended CPH needs job-board spend + recruiter cost inputs — pilot config |
| Diversity / diverse slate % | **No demographic fields by design** (Bias Shield is lexicon-based) | Ask what they capture in Workday; adding a slate-diversity dimension is pilot scope and needs their DPDPA sign-off |
| >30% hike rationale | Comp panel shows current / expected / band; **no hike-% flag or report** | Small add: a hike-% column + threshold flag on the comp desk |
| Assessment deviation (Mettl/Mercer) | **No assessment integration** | Roadmap; ask which tool and whether it has an API |

## G. Environment and hygiene

| # | Item | Action |
|---|---|---|
| G1 **[BLOCKER]** | Comp bands (IN09/IN12/IN14 rupee ranges), Hudson fee terms and benchmark medians are **invented demo values** | Get Sneha/Ashish to confirm or replace on Tuesday; US leadership will quote them |
| G2 | 9 generic Bengaluru tech requisitions may still be on the Solenis tenant (candidate/offboard arcs hang off them) | Verify in DB; archive or re-title before 8 Oct |
| G3 | Nightly full API suite on `main` is **red every night since at least 22 Sep** (`api:test full`); PR gate is green | Shared-staging drift, not a regression; investigate after the meeting |
| G4 | `NEXT_PUBLIC_DEFAULT_TENANT_SLUG` not set on `solenis-portal` | Required once A1 lands |
| G5 | Resend test mode | Any live email on stage must go to `digitalfuturity@outlook.com`; have the inbox open |
| G6 | Iris help mode knows nothing about market intel, feasibility, reports, AI interview or notetaker | If you demo Iris, stay on the 20 listed capabilities |
| G7 | Workday | Integrations page says SIMULATED honestly; Solenis has no integrations today and wants local-leadership-only visibility, which RLS + tenant scoping already give |

## H. Suggested order (Sat 27 → Mon 29)

1. **Sat AM** — A1 slug rename + G4, A2 partner strings, A3 email sample data. Redeploy both portals.
2. **Sat PM** — C1 ASR key + redeploy workers, C2 staged transcript, E1 label rename.
3. **Sun** — B1 AI-interview recruiter card (mode option → generate → approve → issue link).
4. **Mon AM** — D1 benchmark citations (code) while a human pulls real guide figures.
5. **Mon PM** — full dry run on the Solenis domains through all personas; groom.

Tuesday's meeting is the place to close G1 (confirm invented values), E3, F (which of the
missing reports matter to US leadership), and D2 (their own sources / licences).
