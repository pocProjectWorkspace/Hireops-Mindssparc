# Session handoff — 19 July 2026, v2 (persona-pass era, post-RO)

The single source for a fresh orchestrator session. Read this FIRST, then
`docs/demoreadiness.md` and `docs/prototype-gap-audit.md`. Supersedes the
v1 handoff (git history has it) and PLATFORM-BUILD-STATUS for current work.

## 1. Mission state

- **Client demo: Solenis ($9B), Wednesday 22 July.** Internal demo
  (Rajesh/Lakshmi) Monday 20 July. Today is Sunday.
- Era: **persona-by-persona transformation to prototype grade**, driven by
  the user's Lovable-prototype screenshot reviews. DONE: **HR head, HR ops,
  interview panel, requirement owner (hiring_manager)** — four personas,
  each shipped (pushed + Railway + Vercel + reseeded). REMAINING, in the
  user's chosen order: **recruiter (NEXT) → candidate → admin**. Partner
  persona is NOT planned for a pass (existing partner portal stands).
- main @ `0c036ea` pushed. RO-push CI was mid-run at handoff time: 4/5
  quality jobs green, db:lint:rls pending — verdict rule: 5 quality jobs
  green = pass; `api:test` red is the documented tripwire, ignore.
- **Pending loose end:** run `pnpm db:groom:demo-data --execute` once that
  CI's api:test finishes (never groom during a live api:test — churn
  whack-a-mole), then dry-run should read TOTAL 0.
- All EIGHT seeds were re-run post-push (runbook grew: + `db:seed:ro-02`).

## 2. The persona-pass process (proven ×4 — repeat exactly)

1. User drops full-page screenshots into `public/<Persona Name>/` (repo
   /public — untracked, never commit). **Re-list the folder right before
   ingesting** (the user adds files late); Read every image.
2. Produce TWO lists for agreement: **(A) features to build** — table with
   verdicts: build-as-is / build-honestly-different (real AI via ai-client
   where genuine · curated-reference labelled · DETERMINISTIC rule engines
   · REFUSE where required, see §7) / defer. **(B) design upgrades**. Then
   ticket split. WAIT for the user's agreement before dispatching.
3. Dispatch 2–3 parallel executors (Opus, general-purpose): ONE main-tree
   ticket + worktrees (`isolation: "worktree"`). Sizing that worked:
   dashboard+list / data+AI / config+rules-ish splits. **Pre-assign in the
   charters: migration number RANGES per ticket (see §3), component
   ownership (one ticket owns each new shared component; others import
   existing only), nav/router/api-types/gate-list as declared UNION seams,
   and distinct seed + test-fixture id namespaces.**
4. On hand-back, checkpoint-commit each worktree:
   `git -C <wt> add -A -- apps packages package.json` (root package.json
   pathspec ALWAYS — seed passthroughs live there), commit on the wt branch.
5. Merge train: commit main-tree ticket → `git cherry-pick <checkpoint>`
   (merges are hook-blocked; cherry-pick is allowed). Expected conflicts:
   AppShell nav + PortalNavKey (UNION), api package.json test:gate (UNION),
   ai-settings feature keys (UNION ×3 touch points), migration _journal
   (renumber/interleave), schema index (UNION), seeds, procedures.ts.
6. **Conflict craft (hard-won):** same-anchor append conflicts INTERLEAVE
   common context — naive hunk-by-hunk union stitches code mid-body. For
   router-tail/seed-block collisions, COMPOSE from the parents (`git show
   :2:file` / `:3:file`, slice each side's whole block by anchors, emit
   ours-block + theirs-block + common tail). For files with an EMPTY side
   in a hunk, regex `(.*?)` fails — use a line-based marker parser. Restore
   a botched file with `git checkout -m -- <file>` and redo. Prettier the
   resolved files before `cherry-pick --continue`.
7. Post-merge reconciliations from the hand-backs' merge notes (trust and
   apply them), then combined gates: `pnpm typecheck && pnpm lint &&
   pnpm format:check` + portal build + every new/affected vitest suite
   ISOLATED (`NODE_ENV=test DB_POOL_MAX=3 pnpm --filter @hireops/api exec
   vitest run test/<one>.test.ts` — one file per invocation). A first-run
   suite failure after a prompt-affecting change is usually the LocalAI
   fixture harvest — rerun before diagnosing. Fixtures are gitignored.
8. User pushes (HUMAN-ONLY; suggest `! git push origin main`). Then ship
   ritual (§4). Orchestrator MAY run `railway up` itself (established).

## 3. Executor charter essentials (paste into every ticket)

- Read this doc + PLATFORM-BUILD-STATUS + HANDOVER §0 + demoreadiness;
  verify branch-from SHA (`git rev-parse HEAD`);
  `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`.
- NEVER commit/push/merge. Leave tree dirty. Worktrees: `pnpm install`
  once + symlink root `.env` if missing (both gitignored).
- Gates = ONE foreground run-and-print Bash command each; vitest ONE file
  per invocation; NO background waiters ever. **Recovery playbook:** on
  stall/API-drop, resume once via SendMessage with a blunt finish order
  (state exactly what remains); happened ~8 more times this session —
  the work is almost always complete; agents resume cleanly from their
  transcript even after session-limit kills. On repeated failure the
  orchestrator closes out directly from the tree.
- **Migrations: the drizzle snapshot chain is BEHIND the schema (ends at
  0068_snapshot; standing debt). NEVER run drizzle-kit generate — hand-
  write SQL + journal entries.** Orchestrator reserves a number range per
  ticket upfront (next free: **0081**; journal `when` values must exceed
  1784500000010 and stay monotonic per range). Apply via `pnpm db:migrate`;
  if the shared DB's ledger is already past your `when` range, apply the
  SQL directly and SAY SO in the hand-back (RO-01 precedent — its 0077–79
  are applied but absent from `__drizzle_migrations`; harmless).
- Prototype at `~/Desktop/Workspace/procurve-ai-main` is REFERENCE ONLY.
- Shared live DB (dev = staging): seeds may hang (kill+retry once); live
  workers cause documented drain-timing flakes; don't overlap local gates
  with a live CI run. Prototype currency is AED — ours is INR, always.
- Hand-back = data for the orchestrator: built-per-scope, files, migration
  filenames+journal, seed block+namespace, gate tails, MERGE NOTES
  (explicit UNION seams + exact shared-file touch list), deviations.

## 4. Ship ritual (after every push)

```
railway up --service api --detach -y && railway up --service workers --detach -y
# (railway redeploy --from-source is a TRAP — stale snapshot)
# Vercel auto-deploys the internal portal; partner portal is CLI-only.
# CI: gh run watch <id> in background; verdict = 5 quality jobs green;
#     api:test red is the documented tripwire, ignore.
# Reset (order matters; groom only AFTER api:test finishes):
pnpm db:groom:demo-data --execute      # then dry-run → TOTAL 0
pnpm db:seed:test-users && pnpm db:seed:demo-data && pnpm db:seed:partner-demo \
  && pnpm db:seed:candidate-demo && pnpm db:seed:offboard-demo \
  && pnpm db:seed:benchmarks && pnpm db:seed:hr-policies && pnpm db:seed:ro-02
```

## 5. Credentials & surfaces (all passwords `TestPassword123!`)

hireops-portal.vercel.app: `hiringmanager1@` `hrhead1@` `recruiter1@`
`panel1@` `hr_ops1@` `admin1@` (all @kyndryl-poc.test) ·
`priya.subramanian@example.test` at /candidate/login ·
hireops-partner-portal.vercel.app: `partner1@talentbridge-partners.test`.
Email delivers ONLY to digitalfuturity@outlook.com (Resend test mode).

## 6. Reuse inventory (grown across four passes)

- **Patterns** `apps/internal-portal/src/components/patterns/`: PageHeader ·
  HeroStatCard · ActionTriad · StageFunnel · AlertCard · Chips (Priority,
  Outcome, Recommendation, HrRec, Stage, DocStatus, DocOverall). Plus
  reusable: `hr-ops/TabBar` (tabbed entity records), `panel/InterviewCard`,
  `requisitions/{JdEditor, SkillWeightsEditor}` (readOnly-capable),
  `hr-docs/ApplicationDocumentsPanel`, `comp/{CompAnalysisPanel,
  OfferComposerPanel}`. USE THESE. Structural richness > palette
  (DESIGN-05 tokens: slate-ink #16181f sidebar, indigo accent, warm stone).
- **Pure rule engines** (the honest-verdict pattern): `apps/api/src/lib/
  comp-rules.ts` (band verdicts) · `req-health.ts` (health composite +
  difficulty). Copy this shape for new deterministic features.
- **AI features registered** (ai-settings keys, all kill-switchable +
  cost-logged; feasibility pattern w/ cache tables where noted):
  ai_scoring · jd_generation · agent_drafts · jd_bias_review ·
  req_feasibility (requisition_feasibility) · comp_recommendation
  (comp_recommendations) · feedback_summary (ephemeral) · interview_prep
  (interview_prep) · req_revision (req_revision_suggestions).
- **Tables added this era**: hr_round_assessments · comp_recommendations ·
  application_documents · hr_case_notes · hr_policy_documents ·
  interview_prep · req_revision_suggestions. Migrations through **0080**.
  Offers gained contract_type/probation_months/benefits; applications
  gained expected_salary_inr_paise; jd_skills gained min_years/notes.
- **Persona surfaces**: HR head (approvals, market-intel, feasibility,
  metrics, governance, exec-audit) · HR ops (hr-cases six-tab record,
  hr-rounds, comp-offers + out-of-band offer approvals, hr-documents,
  case-audit, hr-policies, hr-analytics) · Panel (dashboard, brief w/
  skills-match + AI prep, board, feedback queue, history, advanced
  scorecard w/ mandatory notes) · Requirement owner (dashboard w/ action
  rules + SLA rail, requisitions v2, 5-step wizard, skill-weighting,
  approval-tracker + req_revision, jd-library, panel-setup, insights).

## 7. Standing decisions & the refusal catalogue (recite in analyses)

- NO demographic/diversity features until a client data-collection policy
  exists. NO psychometrics anywhere (no instrument administered). NO
  emotion/sentiment inference on candidates EVER — prohibited for
  workplace contexts under the EU AI Act; say it as a selling point
  (France/Germany GCC targets). NO invented probabilities (offer-
  acceptance %). NO fictional mechanics in UI copy (RO-02 precedent: the
  scoring text describes the REAL engine, not the prototype's auto-cap).
  Live video/transcripts = post-deal connector work package (Teams/Zoom),
  same seam story as Workday.
- Kyndryl tenant re-brand to neutral (e.g. "NovaChem GCC") — STILL OPEN,
  one seed field + reseed when decided. Ask before Wednesday.
- Debt ledger (post-Wednesday): drizzle snapshot-chain repair · HANDOVER
  ticket log · demoreadiness refresh (eight seeds now; new personas) ·
  RO-01 migrations absent from __drizzle_migrations ledger · candidate
  in-portal offer view lacks contract/probation/benefits terms ·
  market_benchmarks groom class · METRICS extensions.

## 8. First prompt for the recruiter-persona session (user: paste this)

> You are the ORCHESTRATOR for HireOps (continuing role — your memory
> files cover the delegation model; pushes are human-only, you commit,
> you may run railway deploys). Read docs/new-set/session-handoff-19jul.md
> IN FULL first — it is the single source for the persona-pass era — then
> docs/demoreadiness.md. Confirm the loose ends in §1 are closed (groom
> sweep TOTAL 0; RO-push CI verdict) and close them if not. Then: the
> Lovable prototype's RECRUITER persona screenshots are in
> public/Recruiter/ — re-list the folder first (more images may have been
> added since), then ingest EVERY screen image. The recruiter is our
> DEEPEST existing persona (triage + score ring, interview scheduling +
> candidate email confirm, offers drawer, agent approvals queue,
> onboarding day-0, missing-info chase) — expect mostly
> elevation-to-prototype-grade plus honest gap-fills, not new pillars;
> ground every verdict in the existing surfaces before proposing builds.
> Come back with the two agreed-format lists: (A) features to build with
> honest-build verdicts (build-as-is / honestly-different / defer /
> refuse per §7's catalogue), (B) design upgrades — then a 2–3 parallel
> executor ticket split per the proven template in §2–3 (pre-assign
> migration ranges from 0081, component ownership, seed namespaces).
> WAIT for my agreement before dispatching. After recruiter, the
> remaining passes are candidate, then admin. Solenis demo is Wednesday
> 22 July; keep every refusal line demo-ready.
