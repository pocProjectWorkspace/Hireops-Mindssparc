# Session handoff — 19 July 2026 (persona-pass era)

The single source for a fresh orchestrator session. Read this FIRST, then
`docs/demoreadiness.md` and `docs/prototype-gap-audit.md`. The old status
doc (`PLATFORM-BUILD-STATUS.md`) is accurate through construction but does
NOT cover the persona-pass era — this doc supersedes it for current work.

## 1. Mission state

- **Client demo: Solenis ($9B), Wednesday 22 July.** Internal demo
  (Rajesh/Lakshmi) Monday 20 July. Today is Saturday night.
- **Construction is COMPLETE** (all pillars, personas, config — see
  prototype-gap-audit + status doc). Current era: **persona-by-persona
  UI/feature transformation** to prototype-grade, driven by the user's
  screenshot reviews. HR HEAD IS DONE (the template). **NEXT: HR Ops.**
- main @ `5b0bc1e` pushed + one local commit `0514761` (root benchmark
  seed script) unpushed. Everything through the HR-head pass is DEPLOYED
  (Railway api+workers + Vercel, verified live).
- One pending loose end: run `pnpm db:groom:demo-data --execute` once the
  post-push CI `api:test` job finishes (it churns test rows into the
  shared DB while running; grooming during = whack-a-mole; dry-run TOTAL
  should read 0 after).

## 2. The persona-pass process (proven with HR head — repeat exactly)

1. User drops full-page screenshots of the Lovable prototype's persona
   screens into `public/<Persona Name>/` (repo root /public — NOT tracked;
   never commit them). Read every image with the Read tool.
2. Produce TWO lists for agreement: **(A) features to build** — table with
   verdicts: build-as-is / build-honestly-different (no AI theatre — real
   data, real AI via ai-client where genuine, curated-reference where the
   prototype fakes "market data", DETERMINISTIC rule engines for
   alerts/flags, NO demographic anything ever) / defer. **(B) design
   upgrades** — patterns the screens teach.
3. On agreement, dispatch 2–3 parallel executor tickets (Opus,
   general-purpose). Worktrees (`isolation: "worktree"`) when the main
   tree is occupied; main tree otherwise. Ticket sizing: dashboard+list
   surfaces / data+AI features / config+rule-engine pages worked for HR
   head.
4. Checkpoint-commit each worktree on hand-back:
   `git -C <worktree> add -A -- apps packages` **PLUS any root files the
   ticket touched (package.json! — a pathspec miss cost us the benchmark
   seed script)**, then commit on the worktree's feat branch.
5. Merge train: commit the main-tree ticket → `git cherry-pick` the
   worktree checkpoint SHAs (allowed; `git merge` is hook-blocked).
   Conflicts are predictable: apps/api/package.json gate list (UNION the
   test files), AppShell nav array (UNION the items), api-types index
   (UNION exports), router.ts (usually auto-merges — appends).
6. Post-merge reconciliations from the hand-backs' "merge notes" (each
   executor documents expected overlaps — trust and apply them).
7. Combined gates: `pnpm typecheck && pnpm lint && pnpm format:check` +
   portal production build + each new/affected vitest suite ISOLATED
   (`NODE_ENV=test DB_POOL_MAX=3 pnpm --filter @hireops/api exec vitest
   run test/<one>.test.ts` — one file per invocation, concurrent suites
   trip the pooler).
8. User pushes (`git checkout main && git merge --ff-only <branch> &&
   git push origin main` — pushes are HUMAN-ONLY, the hook blocks agents;
   merges too, hence cherry-pick). Then deploy + reset (§4).

## 3. Executor charter essentials (paste into every ticket)

- Read status doc + HANDOVER §0/realities + demoreadiness first; verify
  the branch-from SHA; `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`.
- NEVER commit/push/merge (hook-blocked). Leave tree dirty.
- **Gates = ONE foreground run-and-print Bash command each; vitest ONE
  file per invocation; NO background waiters ever** (the recurring
  failure mode: executors "wait for a monitor" and the watchdog kills
  them; also transient API 500s/stream stalls). **Recovery playbook:**
  resume once via SendMessage with a blunt finish order; on second
  failure, orchestrator closes out directly — verify gates yourself from
  the tree, commit, move on. This happened ~10 times; the work is almost
  always complete when they stall.
- Prototype at `~/Desktop/Workspace/procurve-ai-main` is REFERENCE ONLY —
  never copy files.
- Shared live DB (dev = staging): seeds may hang (kill+retry once —
  mostly fixed by POLISH-02's sql.end()), live workers cause documented
  drain-timing test flakes, don't overlap local gates with a live CI run.

## 4. Ship ritual (after every push)

```
railway up --service api --detach -y && railway up --service workers --detach -y
# (railway redeploy --from-source is a TRAP — redeploys the stale snapshot)
# Vercel auto-deploys the internal portal; partner portal is CLI-deploy only.
# CI: gh run watch <id> in background; verdict = 5 quality jobs green,
#     api:test red is the documented tripwire, ignore.
# Reset (SEVEN steps, order matters):
pnpm db:groom:demo-data --execute
pnpm db:seed:test-users && pnpm db:seed:demo-data && pnpm db:seed:partner-demo \
  && pnpm db:seed:candidate-demo && pnpm db:seed:offboard-demo && pnpm db:seed:benchmarks
```

## 5. Credentials & surfaces (all passwords `TestPassword123!`)

hireops-portal.vercel.app: `hiringmanager1@` `hrhead1@` `recruiter1@`
`panel1@` `hr_ops1@` `admin1@` (all @kyndryl-poc.test) ·
`priya.subramanian@example.test` at /candidate/login ·
hireops-partner-portal.vercel.app: `partner1@talentbridge-partners.test`.
Email delivers ONLY to digitalfuturity@outlook.com (Resend test mode).
Full feature walkthroughs: `docs/demoreadiness.md` (note: it says five
seeds — now six; update on next docs pass).

## 6. What the HR-head pass built (the reuse inventory)

- **Shared patterns** `apps/internal-portal/src/components/patterns/`:
  `PageHeader{title,subtitle?,right?}` · `HeroStatCard{label,value,
  caption?,delta?,icon?,href?}` (accent-filled hero) · `ActionTriad{
  onApprove,onSendBack(reason),onReject(reason)}` · `StageFunnel{stages,
  bottleneck?}` · `AlertCard{severity,chip,entity?,consequence,date?,
  href?}` · `PriorityChip/OutcomeChip`. USE THESE in every persona pass.
- HR-head surfaces: HrHeadDashboard (hero KPI + funnel + decide-inline +
  risk rail), RequisitionApprovalsTable (filter tabs), /market-intelligence
  (curated benchmarks, `market_benchmarks` table, seed
  `db:seed:benchmarks`), /feasibility (REAL AI per-req assessment,
  feature `req_feasibility`, cached in `requisition_feasibility`),
  /metrics (six recharts, `getHrMetrics`), /governance (screeningPrivacy
  + feedbackSharing settings blocks — CONSUMED for real: recruiter-role
  name-masking in triage until tech_interview; candidate portal feedback
  sharing), /exec-audit (compliance score composite + deterministic risk
  flags + SLA table).
- Settings blocks in `tenants.settings` (versioned zod in api-types,
  service-role `||`-merge writes — tenants is FORCE-RLS SELECT-only):
  aiSettings, biasLexicon, scoringWeights, screeningPrivacy,
  feedbackSharing. Sibling-survival is the standing test pattern.
- DESIGN-05 tokens: slate-ink sidebar #16181f, indigo accent, warm stone
  canvas, muted-metallic tier chips. The user found token-only restyling
  too subtle — **structural richness (the patterns above) is what reads
  as "finished", not palette**.

## 7. Standing decisions & constraints

- NO demographic/diversity features, ever, until a client data-collection
  policy exists (the honest line — it's a selling point, say it plainly).
- No AI theatre: fake numbers/facades from the prototype are rebuilt as
  real AI (cost-logged, kill-switchable), curated reference data
  (labelled), or deterministic rules. This trio covered everything so far.
- Kyndryl tenant naming: for Wednesday, the user was advised to re-brand
  the demo tenant display name neutral (e.g. "NovaChem GCC") — DECISION
  STILL OPEN, one seed field + reseed when made.
- Remaining personas after HR Ops: recruiter, hiring manager, panelist,
  partner, candidate, admin (order = user's choice, screenshot-driven).
- Post-Wednesday debt: HANDOVER ticket log (huge), status-doc refresh,
  demoreadiness six-seed fix, METRICS conversion/dept/recruiter-efficiency
  extensions, groom class for market_benchmarks residue.

## 8. First prompt for the new session (user: paste this)

> You are the ORCHESTRATOR for HireOps (continuing role — your memory
> files cover the delegation model; pushes are human-only, you commit).
> Read docs/new-set/session-handoff-19jul.md IN FULL first — it is the
> single source for the current persona-pass era — then
> docs/demoreadiness.md. Then: I have placed the Lovable prototype's
> HR OPS persona screenshots in public/ (find the folder). Ingest every
> screen image, and come back with the two agreed-format lists: (A)
> features to build with honest-build verdicts, (B) design upgrades —
> sized into 2–3 parallel executor tickets per the proven template in
> the handoff §2–3. Wait for my agreement before dispatching. Solenis
> demo is Wednesday; internal demo Monday.
