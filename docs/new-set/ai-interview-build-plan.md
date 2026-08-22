# AI first-round interview — assessed build plan

Date: 2026-08-21 · Source: client ask following the August demo ("an AI interview feature for
first round, something like Metaview"), assessed against the codebase at `main` (`28944fe`,
latest migration **0117**).

Companion to `docs/new-set/reporting-notetaker-build-plan.md` (12 Aug), whose Phase R2 owns the
notetaker. This doc supersedes R2's sequencing: the notetaker and the AI interviewer are the same
pipeline with two different sources, and building them as one phase is cheaper than building
either alone.

---

## 1. The ask is ambiguous, and the ambiguity is expensive

Metaview is **interview intelligence**, not an interviewer. It joins a human call, transcribes it,
and produces structured notes and scorecards. It does not conduct a round. So "an AI interview
feature for first round, something like Metaview" is two products in one sentence:

| | What it is | What it solves | Codebase state |
|---|---|---|---|
| **A. Notetaker** (literal Metaview) | AI sits in on a human first round | Note quality, feedback turnaround, scorecard calibration | Schema + consent done (0116/0117); pipeline absent |
| **B. AI interviewer** | AI *conducts* the first round; recruiter reviews evidence | Panel capacity — `requirements.md` §1 puts the tenant at ~1,500 interviews/month, ~75/day, peak ~150 | Nothing built; but it lands on A's pipeline |

The stated pain in the requirements is capacity, which is B. The named benchmark is A. **Confirm
which before dispatch** — one question does it: *does the AI run the round, or sit in on it?*

This plan builds the shared pipeline first (needed for both), then B behind it, because B is the
one the volume numbers justify and the one that demos.

## 2. What already exists — verified, not assumed

Migration **0116** (`0116_interview_notetaker.sql`) landed the entire capture→derivation chain, and
its shapes anticipate this work more closely than the ticket that wrote them intended:

- `interview_recording_consents` — append-only, per-interview, purpose-scoped by CHECK constraint,
  withdrawable. `0117` added internal revocation. `apps/api/src/lib/interview-recording-consent.ts`
  is the single resolver: absence is not permission, latest row wins, and recruiter intent
  (`interviews.recording_requested`) is required on top of candidate consent. **Reusable verbatim.**
- `interview_recordings` — one media artefact per interview, with a `source` discriminator already
  written as an open question (`'manual_upload' | 'vendor_bot'`) and a status ladder
  `pending → uploaded → transcribing → transcribed | failed`.
- `interview_transcripts` — `segments` jsonb of `{ speaker, startMs, endMs, text }` plus a
  flattened `full_text` the summariser consumes. Provider-agnostic by design.
- `interview_notes` — the derived AI row, one per interview, replaced on regeneration, stamped with
  `model` + `prompt_version`. **It carries no score, no rating, no recommendation column, and that
  omission is load-bearing** (see §5).
- `transcript_outbox` — cloned from `ai_score_outbox`: same status ladder, `attempt_count` /
  `attempt_cap`, `claimed_at` / `claimed_by` lease columns for `FOR UPDATE SKIP LOCKED` + orphan
  sweep. The table shipped; the worker did not.
- `interview_notes` is already a registered `AI_FEATURE_KEYS` entry — kill switch, model allowlist,
  per-tenant BYO key, and `ai_usage_logs` cost attribution all come free.

Two more seams that make B cheaper than it looks:

- **The rubric already exists and is already snapshotted.** `interviews.scorecard_criteria_snapshot`
  (migration 0102) holds the resolved, ordered `[{key,label}]` a human panellist is scored against,
  frozen at schedule time. `interview_plans.competency_focus` holds the round's competency list.
  The AI round's evidence report maps 1:1 onto that same rubric — no parallel vocabulary, and the
  same anti-drift guarantee.
- **The unauthenticated signed-link pattern is built three times over.**
  `apps/api/src/routes/interviews.ts` resolves tenant from `confirm_signed_link_token_hash`,
  enforces single use via `signed_link_uses` (partial unique on success), and already hosts the
  recording-consent POST. Offer accept and candidate document upload use the same shape.

## 3. What is genuinely new

Five things, in dependency order:

1. **ASR.** No speech-to-text anywhere in the repo. This is the first external AI dependency that
   is not token-priced (see §6).
2. **The transcript drain worker.** `apps/workers/src/lib/ai-score-drain.ts` is the template —
   same claim/lease/attempt-cap shape, registered in `src/index.ts` as a fifth drain loop alongside the notification dispatcher, workday-simulation, ai-score and agent-run drains.
3. **Storage signed URLs.** `apps/api/src/lib/storage/types.ts` says it plainly: "richer features
   (signed URLs, lifecycle policies) land when a feature needs them." Audio needs them, and needs
   the 10MB resume-shaped cap revisited.
4. **The AI interview session itself** — question plan, turn state, per-answer capture.
5. **The evidence report** — rubric-mapped, quote-grounded, no score.

Note what is *not* on this list: inbound vendor webhooks. Phase 1 is candidate-browser capture with
a batch ASR call, so the first HMAC-verified vendor webhook route is deferred to the Phase 3 vendor
adapter — the notetaker plan's §2.5 item (1) does not block anything here.

## 4. Build sequence

House rules apply: one gated ticket at a time, migration numbering continues at **0118**, new
surfaces use `PageContainer`, prompt/query logic goes in `apps/api/src/lib/*` — `router.ts` is
already 1.1MB and must not grow inline SQL.

### Phase N3 — the shared pipeline (~1.5–2 wks) · *serves both A and B*

- **N3.1 ASR adapter.** `packages/ai-client/src/asr/` following the existing three-tier pattern
  (`getStorageClient` / `getAIClient` are the precedents): `DeepgramASRClient`, `LocalASRClient`
  (fixture-driven, for `NODE_ENV=test` / `AI_CLIENT_MODE=local`), `getASRClient()` dispatched by
  env. Returns the `{ speaker, startMs, endMs, text }` segment shape `interview_transcripts`
  already stores, so the schema needs no change.
- **N3.2 Storage signed URLs + media caps.** Extend `StorageClient` with `getSignedUrl(key, ttl)`
  on both `supabase.ts` and `local.ts`; separate the media size cap from the resume cap.
- **N3.3 Transcript drain worker.** `apps/workers/src/lib/transcript-drain.ts`, cloned from
  `ai-score-drain.ts`. Claims `transcript_outbox` rows, pulls media, calls the ASR client, writes
  `interview_transcripts`, advances `interview_recordings.status`, then calls
  `completeStructured` under the `interview_notes` feature key to write `interview_notes`.
  Orphan sweep for rows stuck in `processing`, per the ai-score-drain precedent.
- **N3.4 Recruiter upload surface + notes UI.** The `manual_upload` path 0116 designed for:
  recruiter uploads the audio/VTT their meeting tool already produced, gated on
  `canRecordInterview`. Notes render on the panel feedback flow and the candidate drawer —
  **assistive only, never auto-filling a recommendation.**

**N3 alone ships option A.** If the client meant the notetaker, stop here.

### Phase N4 — the async AI interview (~2–2.5 wks)

Asynchronous and structured: the candidate answers a fixed question set, one at a time. **No
real-time duplex voice** — no WebRTC, no telephony, no turn-taking, no barge-in, no sub-second
latency budget. That is where roughly 80% of the demo value sits against roughly 10% of the
engineering risk.

- **N4.1 Migration 0118.** Three small, additive changes plus one new table:
  - `interview_recordings.source` CHECK gains `'ai_interview'`.
  - `interview_recording_consents.captured_via` CHECK gains `'ai_interview_link'`.
  - `interviews.mode` CHECK gains `'ai_async'` (currently `'video' | 'onsite' | 'phone'`, set in
    0051 and mirrored in `interview_plans`, `tenant_interview_round_template`, and
    `interviewModeSchema` in `packages/api-types/src/enums.ts` — all four must move together).
  - New `ai_interview_sessions`: the question plan (generated, then frozen), per-question turn
    state, `started_at` / `submitted_at` / `expires_at`, and the signed-link token hash.
    Conventions are 0116's — composite `(tenant_id, id)` unique, compound FKs, FORCE RLS,
    audit trigger.

  **Deliberately unchanged:** `uniq_interview_recordings_per_interview`. One AI round produces one
  recording row; per-question boundaries live in `interview_transcripts.segments`, which already
  carries `startMs`/`endMs`. Relaxing that unique to get per-question rows would fork the
  notetaker's shape for no gain.

- **N4.2 Question generation.** New AI feature key `ai_interview_questions`. Grounded **only** in
  the JD text, `jd_skills`, `requisition_knockouts`, `interview_plans.competency_focus`, and the
  round's `scorecard_criteria_snapshot` — the same honest-inputs discipline as
  `interview-prep.ts`. Questions are generated once, frozen into the session row, and shown to the
  recruiter for approval before the invite goes out. Every question carries the rubric key it
  probes.
- **N4.3 Candidate surface.** Signed-link route on `apps/api/src/routes/interviews.ts`, same
  verify/`signed_link_uses` shape as `/confirm/:token`. Disclosure + recording consent on entry
  (the existing consent resolver, new `captured_via`). One question at a time, browser
  `MediaRecorder` audio upload per answer via signed URL, with a typed-answer fallback for
  bandwidth or accessibility. Answers stitched into one recording artefact on submit → enqueue
  `transcript_outbox` → N3's drain does the rest.
- **N4.4 Evidence report.** New feature key `ai_interview_evidence`. Output is a per-rubric-item
  record: covered / not covered, the candidate's own words as a verbatim quote with a transcript
  offset, and explicit knockout verification against `requisition_knockouts`. **No score, no
  rating, no advance/reject.** Stored as an additive `evidence` jsonb on `interview_notes` — same
  regenerate-replaces semantics, same `model` + `prompt_version` provenance.
- **N4.5 Recruiter review surface.** The evidence report next to the transcript with click-to-seek,
  feeding the existing `interview_feedback` flow. The `strong_yes | yes | hold | no` vocabulary
  stays human-written — the AI never populates it.

### Phase N5 — post-contract, not before

Conversational follow-ups (same chain plus a turn loop); a `vendor_bot` adapter for recorded human
rounds (Recall.ai-style, and the first inbound HMAC-verified webhook route); real-time duplex
voice. Robust turn-taking across GCC and Indian English accents is a product, not a sprint —
`requirements.md` already commits the platform to that linguistic reality and it should not be
discovered mid-demo.

## 5. The governance stance — and why it is also the differentiator

`0116` states it in the DDL: *"no score, no rating, no recommendation column. Notes assist the
panellist; they never auto-fill a hire/no-hire. That is a product stance, not an unfinished
schema."* An AI interviewer that filters candidates breaks that stance. **It should not be
allowed to.**

The position to hold, and to sell: **the AI round produces evidence; a human advances or rejects.**

- **GDPR Art. 22** — no decision based solely on automated processing with legal or similarly
  significant effect. Applies today, and the Kyndryl pitch targets GCC clients in France and
  Germany (`PLATFORM-BUILD-STATUS.md`, 14 July).
- **EU AI Act** — Annex III makes recruitment and candidate filtering high-risk. The Digital
  Omnibus deferred stand-alone Annex III obligations from 2 Aug 2026 to **2 December 2027**, so
  there is runway, but the structure is unchanged and the deferral is not a reprieve from
  designing for it.
- **AI Act Art. 50 transparency** — the candidate must be told they are interacting with an AI.
  Deferral does not touch this. It belongs in N4.3's disclosure copy, not a settings page.
- **No inference beyond words.** No sentiment, psychometric, personality, confidence or fluency
  scoring, and no demographic inference — from voice, video or text. `interview-prep.ts`'s system
  prompt already forbids exactly this; extend the same clause. Facial and vocal analysis is what
  produced the HireVue complaint, and refusing to do it is a trust asset with an enterprise buyer,
  not a limitation to apologise for.
- **Auditability comes free.** Every call is already logged to `ai_usage_logs` with feature, model,
  tokens and cost; prompts are version-stamped; the whole feature sits behind a per-tenant kill
  switch. The wedge is "AI you can audit" — this is the highest-stakes place to prove it.

Practical consequence for the demo script: the AI round is narrated as *"it does the asking and the
listening; your recruiter still does the deciding, and here is the audit trail."*

## 6. Commercial impact — one new COGS shape

`AI-usage-inventory-and-cost-model.md` (21 Aug) buckets cost by volume driver, all of it token-priced
across 14 call sites. **ASR is the first line that is not.** It is priced per audio-minute and its
driver is interviews, not applications — at ~1,500 interviews/month a 30-minute first round is
~45,000 minutes/month of audio before a single token is spent.

Two consequences:

1. Add an **interview-minutes** bucket to that inventory and to
   `COMMERCIAL-sizing-and-hosting-cost-model.md` before anyone quotes a per-seat number.
2. It is a strong argument against buying a vendor (§7): a per-minute vendor fee stacks *on top of*
   the ASR minute, not instead of it.

## 7. Build vs buy

Buying (HeyMilo, Ribbon, Apriora, Micro1) reaches a screenshot faster. It is still the wrong call
here:

- **COGS.** Per-candidate per-minute pricing at this volume, on top of ASR if the notetaker also
  ships.
- **Channel conflict.** Kyndryl resells HireOps to its GCC clients. Embedding a competitor's
  product inside the thing being resold undercuts the pitch and hands the client a substitution
  path to the vendor directly.
- **The integration saving is smaller than it looks.** There are zero inbound webhook endpoints in
  the codebase; the first HMAC-verified vendor route gets built either way, and the vendor's data
  model still has to be mapped onto `interview_transcripts` / `interview_notes` to reach the
  reports and the scorecards.
- **It cannot be governed.** The kill switch, BYO key, cost ledger, prompt versioning and
  no-inference guarantees of §5 all stop at the vendor boundary — precisely the layer being sold as
  the differentiator.

Buy only if a logo is needed on a screen inside three weeks.

## 8. Decisions needed before dispatch

1. **A or B** (§1). Everything downstream of N3 depends on it. Ask the client directly.
2. **Voice or text for the candidate answer.** Voice is the better demo and pulls in ASR cost and
   accent risk; text is nearly free and lands the same evidence report. Recommendation: voice with
   a typed fallback, both from day one — the fallback is also the accessibility answer.
3. **ASR vendor.** Deepgram (per-minute, diarisation, good non-native English) vs Whisper via API
   (cheaper, weaker diarisation) vs the provider's own audio path. Affects §6's number.
4. **Where the AI round sits in the funnel.** A new `ai_async` round on the existing interview plan
   (recommended — it inherits scheduling, reporting, `completed_at`, interview-health) versus a
   pre-interview screening step before any `interviews` row exists. The former is materially less
   work and keeps every existing report correct.
5. **Retention.** Interview audio is the most sensitive artefact the platform will hold. There is
   no retention-policy table (only `document_types.retention_years`); pick a default TTL and a
   deletion path before the first recording exists, not after.
6. **Demo timing vs the Workday work package.** N3+N4 is ~4 weeks. The notetaker plan already
   flagged that this phase competes for POC time; N3 alone (~2 weeks) is a shippable client answer
   if the window is shorter.

---

## Appendix — file-level map

| Concern | Where it lives / lands |
|---|---|
| Consent resolution | `apps/api/src/lib/interview-recording-consent.ts` (exists, reuse) |
| Signed-link candidate routes | `apps/api/src/routes/interviews.ts` (exists, extend) |
| Drain worker template | `apps/workers/src/lib/ai-score-drain.ts` → `transcript-drain.ts` (new) |
| Worker registration | `apps/workers/src/index.ts` (5 scheduled scans + 4 drain loops today) |
| ASR client | `packages/ai-client/src/asr/` (new, three-tier pattern) |
| Storage signed URLs | `apps/api/src/lib/storage/{types,supabase,local}.ts` (extend) |
| Prompt + schema builders | `apps/api/src/lib/interview-prep.ts` is the pattern to copy |
| AI feature keys | `packages/api-types/src/ai-settings.ts` (12 today; +2) |
| Interview mode enum | `packages/api-types/src/enums.ts` + three CHECK constraints |
| Migration | `packages/db/drizzle/migrations/0118_ai_interview.sql` (new) |

---

## Appendix B — per-service environment requirements

**Added 22 August 2026, after a deploy caught a gap no gate could.** The
`interview_media_purge` sweep shipped, deployed, and errored on its first
production run: the Railway **workers** service had `SUPABASE_KEK_SECRET` but
neither `SUPABASE_URL` nor `SUPABASE_SERVICE_ROLE_KEY`, so `getStorageClient()`
threw. The transcript drain shares that dependency
(`transcript-drain.ts` mints a signed read URL), so the first recruiter upload
would have failed at the media fetch and read like an ASR fault rather than a
missing environment variable.

**Why every gate passed anyway.** Local tiers resolve without credentials —
`NODE_ENV=test` selects `LocalStorageClient` and `LocalASRClient`, which need no
keys by design, because that is what makes the suite runnable offline. There is
no test that can fail on a production env var being absent. So this class of bug
is invisible until deploy, and the only defence is writing the requirement down
next to the code that introduces it.

**The rule: when a ticket makes a service reach a new external system, add the
variable here in the same ticket.** A service is not "deployed" until its env is
verified, and a job erroring once per interval is easy to miss in logs nobody is
tailing.

| Service | Needs | Introduced by |
|---|---|---|
| `api` | `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_KEK_SECRET`, `SIGNED_LINK_SECRET`, `RESEND_API_KEY`, `STORAGE_BUCKET` | pre-existing |
| `workers` | all of the above **plus** `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for storage | **N3.3a / N3.RET** — the drain fetches media, the purge deletes it |
| `workers` | `ASSEMBLYAI_API_KEY` (+ optional `ASSEMBLYAI_REGION`) | **N3.1b** — not yet set anywhere; the drain runs on the local tier until it is |
| `workers` | optional `ASR_PROVIDER` (`assemblyai` default, `deepgram` selectable) | N3.1b — an unrecognised value throws rather than silently billing the other vendor |
| both | optional `MEDIA_MAX_UPLOAD_BYTES` (250MB default) | N3.2 |

**Two verification lessons from the same incident, both non-obvious:**

1. **`railway variables` truncates.** The table and `--kv` views both cut long
   values and made a successful `--set` look like it had failed. Use
   `railway variables --service <name> --json` to confirm what is actually set.
2. **The absence of an error after a restart is not proof of a fix.** A
   scheduled job that already ran — including one that ran and *errored* — will
   not run again until its interval elapses, which for the purge sweep is 24
   hours. To prove a fix now, backdate its bookkeeping row
   (`UPDATE scheduled_job_runs SET last_run_at = now() - interval '2 days'
   WHERE job_name = '<job>'`) and watch the next tick. The healthy line for the
   purge is `purged=0 failed=0 retention_days=30 hard_ceiling_days=90`.
