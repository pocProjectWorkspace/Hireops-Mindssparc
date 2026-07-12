# HireOps — Staging Deployment Runbook

**Purpose.** Step-by-step, from zero, to stand up a working **staging** environment for the August Kyndryl demo. This is written so that once the accounts exist, staging is *execution, not discovery* — every account-independent decision is already made and the deploy manifests are in the repo (`apps/api/Dockerfile` + `fly.toml`, `apps/workers/Dockerfile` + `fly.toml`, portal env-driven).

**Decided shape (locked):**
- **`apps/internal-portal`** (Next.js 14 App Router) → **Vercel**
- **`apps/api`** (Hono + tRPC) and **`apps/workers`** (polling loops) → **Fly.io**, region `bom` (Mumbai / ap-south-1 alignment, per Workday ADR §3.5 — long-running Node processes, not serverless)
- **Postgres + Auth** → a **separate staging Supabase project** (never share the dev project)

**Scope.** Staging only. No production, no custom domains/TLS beyond the notes here, no CI/CD (manual `fly deploy` / Vercel dashboard first).

**Prerequisites on the operator's machine:**
```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"   # Node 22 — required for pnpm
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
npm i -g vercel                # Vercel CLI (optional; dashboard works too)
fly auth login
vercel login
```

> **A load-bearing architectural fact that shapes the whole env story.** The
> internal portal is **not a thin HTTP client** of the api. Its server
> components run the api's tRPC router **in-process** via
> `appRouter.createCaller` (`apps/internal-portal/src/lib/trpc-server.ts`),
> talking straight to Postgres with the pooled `sql` client. **Consequence:
> the portal's Vercel runtime needs the api's server secrets** (`DATABASE_URL`,
> `SUPABASE_KEK_SECRET`, `SIGNED_LINK_SECRET`, storage creds) **in addition to
> the `NEXT_PUBLIC_*` browser vars.** The public apply/offer pages are the only
> things that hit the api over HTTP (`NEXT_PUBLIC_API_BASE*`). Plan the Vercel
> env accordingly (§7).

---

## 0. Order of operations (the critical path)

1. **Supabase project** (§1) — nothing else works without the DB + auth.
2. **Migrations** 0000–0044 (§2) — schema, RLS, audit partitions, the auth-hook function.
3. **Enable the custom access-token hook** in the Supabase dashboard (§3) — dashboard-side, easy to forget, silently breaks tenancy if skipped.
4. **Seed** test users + demo data (§4).
5. **Fly apps** ×2 + secrets (§5, §6) — api and workers.
6. **Vercel project** + env (§7).
7. **CORS + cross-origin wiring** (§8) — point the api at the portal origin.
8. **Resend + Anthropic credential** (§9, §10).
9. **Smoke checklist** (§11).

Do them in this order. Steps 5–7 can overlap once the DB (1–4) is live.

---

## 1. Create the staging Supabase project

1. Supabase dashboard → **New project**. Name `hireops-staging`. **Region: `ap-south-1` (Mumbai)** to match Fly `bom`.
2. Save the generated **database password** (you can't retrieve it later).
3. Dashboard → **Connect** (top bar). Copy **both** pooler URIs — HireOps uses the dual-connection pattern (this is a real landmine — see HANDOVER realities):
   - **Transaction-mode pooler, port 6543** → this becomes `DATABASE_URL` (runtime queries; `prepare:false` in the client because transaction pooling can't do prepared statements).
   - **Session-mode pooler, port 5432** → this becomes `DIRECT_URL` (migrations + any long-running/prepared-statement work). Do **not** use the legacy `db.<ref>.supabase.co` direct host — it's IPv6-only on the free tier and fails on IPv4 networks.
   - Username is `postgres.<PROJECT_REF>` **with the dot** (Supavisor requires it).
4. Dashboard → **Settings → API**. Copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon key** → `SUPABASE_ANON_KEY` (public; safe client-side)
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (server-only, never ships to a browser)
5. Dashboard → **Storage** → create a bucket named **`candidate-uploads`** (the resume/offer-letter store; it lives outside Drizzle, so migrations don't create it). Keep it **private**; the api writes with the service-role key.
6. Generate the two local secrets:
   ```bash
   # 32-byte KEK for envelope encryption (wraps per-tenant DEKs):
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → SUPABASE_KEK_SECRET
   # signed-link HMAC secret (candidate offer/withdraw links):
   openssl rand -base64 48                                                     # → SIGNED_LINK_SECRET
   ```
   Keep these identical across api + workers + portal — they must agree or envelope-decrypt and link-verify break across processes.

---

## 2. Run migrations 0000–0044

Migrations run against the **session pooler** (`DIRECT_URL`, 5432), not the transaction pooler. `packages/db/src/migrate.ts` refuses to run without `DIRECT_URL` set and tells you why.

From a machine with the repo (a local `.env` pointed at the staging project, or inline env):
```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
# .env must contain the STAGING DATABASE_URL + DIRECT_URL (+ SUPABASE_KEK_SECRET
# for any script that provisions a DEK). Then:
pnpm db:migrate
```
This applies **0000 → 0044** in journal order. Notable ones:
- **0002** — creates `public.custom_access_token_hook(jsonb)` + grants for `supabase_auth_admin`. The function exists after this migration but is **NOT active until you enable it in the dashboard** (§3).
- **0042** — pre-creates `audit_logs` monthly partitions **2026-07 → 2027-06**. This is not optional: **every audited write fails if the target month's partition is missing** (HANDOVER reality #112). The migration covers the whole demo window, so **no manual partition work is needed for staging.** (This recurs annually until an auto-rotation job ships — open-question #35 — irrelevant before mid-2027.)
- **0043 / 0044** — `pii_access_log` table + FORCE RLS.

Confirm success:
```bash
pnpm db:test:verify-rls   # sanity-checks RLS wiring against the project
```

---

## 3. Enable the custom access-token hook (DASHBOARD — do not skip)

The hook injects `tid` / `tenant_slug` / `roles` JWT claims at sign-in. The SQL side is migration 0002; **activating it is a dashboard toggle** and is the single most common way to get a staging Supabase that "logs in fine but every tenant-scoped query returns empty" (HANDOVER realities #278, #281).

Dashboard → **Authentication → Hooks → Customize Access Token (JWT) Claims**:
- Toggle **on**
- Source: **Postgres**
- Schema: **public**
- Function: **`custom_access_token_hook`**
- **Save**, then wait ~60s for propagation before testing.

Two gotchas from the dev project:
- The hook runs as `supabase_auth_admin`, which does **not** bypass FORCE RLS. Migration 0002/0003 already grant `supabase_auth_admin` SELECT on `tenants` + `tenant_user_memberships`; if you ever see valid-looking JWTs with **no** `tid` claim, that grant is the suspect.
- **Supabase pause/resume can silently reset this dashboard registration.** If claims vanish after the project sleeps, re-toggle here. `pnpm db:diagnose:hook` isolates "function is correct" from "dashboard registration is on" — run it first when chasing a missing-claims failure.

---

## 4. Seed test users + demo data

> **Seed-after-any-test-run rule:** the api test suite mutates shared data. On staging you generally won't run tests, but if you ever do, **re-run both seeds afterward** or the demo will be missing its agent + pending approval.

```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
pnpm db:seed:test-users   # creates the test users below via Supabase Auth admin API
pnpm db:seed:demo-data     # demo tenant, reqs, candidates, AND the SEED-01 wedge:
                           #   "Demo Follow-ups Agent" + a pre-seeded pending approval
                           #   (Candidate G / Rohan) + the scanner live-fire target.
```
Test users (password `TestPassword123!`): `recruiter1@kyndryl-poc.test`, `hr_ops1@kyndryl-poc.test`, `admin1@kyndryl-poc.test`.

- `seed-test-users` needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (Auth admin) + `DATABASE_URL`.
- `seed-demo-data` needs `DATABASE_URL` + `SIGNED_LINK_SECRET` + `NEXT_PUBLIC_SITE_URL` (it bakes portal links into seeded rows — set it to the staging **portal** URL so seeded offer links point at staging, not localhost).
- The demo pending approval (Rohan) is authored to render **without** an AI credential, so it survives even before §10. The scanner target (Meera) needs the agent-run drain (workers) live to fire.

---

## 5. Fly — create the two apps

Both Fly apps deploy **from the repo root** (the Docker build is monorepo-aware; see the header comments in each `Dockerfile`). The `fly.toml` files ship placeholder app names (`hireops-api-staging`, `hireops-workers-staging`) and `primary_region = "bom"`.

```bash
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
cd <repo-root>

fly apps create hireops-api-staging
fly apps create hireops-workers-staging
```
If you pick different names, update the `app = "…"` line in each `apps/*/fly.toml`.

**Monorepo Docker strategy (already implemented in the Dockerfiles).** HireOps runs everything from **TypeScript source under `tsx`** — no `tsc`/`dist` build step; the `@hireops/*` workspace packages are consumed as source (their `main` points at `src/index.ts`). So each image does:
1. `node:22-slim` + pnpm via corepack.
2. Copy the whole workspace, `pnpm install --frozen-lockfile`.
3. `pnpm --filter=@hireops/<app> --legacy deploy --prod=false /out` — prunes the workspace to just that app + its transitive deps into a self-contained `/out` (its own `node_modules` with every `@hireops/*` dep copied in as source). `--legacy` is required because the packages are source-consumed, not injected; `--prod=false` keeps `tsx`, which lives in `devDependencies` but **is** the runtime.
4. Runtime stage copies `/out` and runs `node_modules/.bin/tsx src/index.ts` directly (not `pnpm start` — that would trigger a corepack pnpm download on every cold start).

`.dockerignore` (repo root) keeps `.env`, `node_modules`, `.next`, tests, and docs out of the build context.

---

## 6. Fly — deploy + set secrets

### 6a. Secrets (per app)

Set every secret **before** the first deploy so the process boots healthy. Non-secret config (`PORT`, `NODE_ENV`) is already in `fly.toml [env]`.

**`apps/api` — `fly secrets set -a hireops-api-staging …`:**

| Secret | Required? | Value / source |
|---|---|---|
| `DATABASE_URL` | **required** | staging **transaction** pooler (6543) — `packages/db` client |
| `SUPABASE_URL` | **required** | staging project URL — JWT/JWKS verify + storage |
| `SUPABASE_ANON_KEY` | **required** | anon key — JWT verify path |
| `SUPABASE_SERVICE_ROLE_KEY` | **required** | service_role — `candidate-uploads` storage writes |
| `SUPABASE_KEK_SECRET` | **required** | the 64-hex KEK from §1.6 — envelope encryption (DEKs, AI creds) |
| `SIGNED_LINK_SECRET` | **required** | the §1.6 HMAC secret — candidate offer/withdraw links |
| `CORS_ALLOWED_ORIGINS` | **required** | the staging **portal** origin(s), comma-separated — see §8 |
| `NEXT_PUBLIC_SITE_URL` | **required** | staging **portal** URL — the api bakes portal links into offer emails (`routes/offers.ts`, `trpc/router.ts`) |
| `LOG_LEVEL` | optional | default `info` |
| `SENTRY_DSN` | optional | unset → errors route through pino to stdout |
| `SENTRY_TRACES_SAMPLE_RATE` | optional | default `0` |
| `STORAGE_PROVIDER` | optional | leave **unset** for Supabase storage (default). `local` = in-memory (dev only) |
| `STORAGE_BUCKET` | optional | default `candidate-uploads` |
| `AI_CLIENT_MODE` | optional | leave **unset** for real Anthropic (per-tenant credential). `local` = fixtures, no key |
| `KMS_PROVIDER` | optional | default `local` (uses `SUPABASE_KEK_SECRET`) |
| `APP_VERSION` | optional | surfaced in `/api/healthz` |

> `PORT=8080` and `NODE_ENV=production` are in `fly.toml`/the image — **not** secrets.
> `DIRECT_URL` is **not** needed by the api at runtime (migrations only).
> The api does **not** send email — `EMAIL_*` belongs to workers.

**`apps/workers` — `fly secrets set -a hireops-workers-staging …`:**

| Secret | Required? | Value / source |
|---|---|---|
| `DATABASE_URL` | **required** | staging transaction pooler (6543) — all drains |
| `SUPABASE_KEK_SECRET` | **required** | same KEK — AI-client decrypt (agent `draft_message`, AI-score drain) |
| `SIGNED_LINK_SECRET` | **required** | same HMAC — outbound emails carry signed links |
| `NEXT_PUBLIC_SITE_URL` | **required** | staging portal URL — `sla-imminent-scan` + email link bodies |
| `EMAIL_PROVIDER` | **required for real send** | `resend` (see §9). Unset/`local` writes to `dev_email_outbox` (no real send) |
| `RESEND_API_KEY` | **required if `EMAIL_PROVIDER=resend`** | from Resend (§9) — owned by the parallel RESEND-01 ticket |
| `EMAIL_FROM` | **required if `EMAIL_PROVIDER=resend`** | verified sender, e.g. `HireOps <noreply@staging.hireops.app>` (§9) |
| `AI_CLIENT_MODE` | optional | unset for real Anthropic; `local` for fixtures |
| `KMS_PROVIDER` | optional | default `local` |
| `LOG_LEVEL` / `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` | optional | as above |

> The worker does **not** use `SUPABASE_URL` / anon / service-role at runtime (it talks Postgres directly). `NODE_ENV=production` is in `fly.toml`.

### 6b. Deploy

```bash
cd <repo-root>
fly deploy -c apps/api/fly.toml
fly deploy -c apps/workers/fly.toml

# Worker singleton (Wave 1): exactly ONE machine. Fly can't express
# min_machines_running without a service block, so pin the count:
fly scale count 1 -c apps/workers/fly.toml
# NEVER scale the worker above 1 until the multi-instance work lands.
# (The dispatcher's SKIP LOCKED + the scheduler's advisory lock make it
# safe-by-construction later, but Wave 1 assumes a singleton.)
```
The api keeps one machine always warm (`auto_stop_machines = "off"`, `min_machines_running = 1`) so there's no cold-start mid-demo. Health check hits **`/api/healthz`** (no DB touch → stays green even if the pooler blips).

Verify:
```bash
fly status -a hireops-api-staging
curl https://hireops-api-staging.fly.dev/api/healthz     # → {"ok":true,"service":"hireops-api",...}
fly logs -a hireops-workers-staging                       # → expect "worker.ready" + drain passes
```

---

## 7. Vercel — the internal portal

**No `vercel.json` is required** (and none ships): Vercel's monorepo detection handles a pnpm workspace natively once **Root Directory** is set. Everything else is dashboard config, documented here.

### 7a. Project settings (dashboard → Project → Settings)

- **Framework preset:** Next.js
- **Root Directory:** `apps/internal-portal` (Vercel auto-detects `pnpm-workspace.yaml` at the repo root and installs from there — the workspace TS deps are handled by Next's `transpilePackages`; no custom install command needed)
- **Build command:** default (`next build`)
- **Install command:** default (Vercel runs `pnpm install` at the workspace root)
- **Node version:** 22.x

### 7b. Environment variables (dashboard → Settings → Environment Variables)

Because the portal runs api procedures **in-process** (see the banner at the top), it needs **both** the browser `NEXT_PUBLIC_*` vars **and** the api server secrets.

**Browser (`NEXT_PUBLIC_*`) — build-time-inlined + runtime:**

| Var | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | staging Supabase project URL (middleware auth + `lib/env.ts` — **required**) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | staging anon key (**required**) |
| `NEXT_PUBLIC_ENV` | `staging` |
| `NEXT_PUBLIC_SITE_URL` | the portal's own staging URL, e.g. `https://hireops-staging.vercel.app` — drives the logout redirect **and** the Server-Actions `allowedOrigins` (STAGING-PREP-01 made both env-derived) |
| `NEXT_PUBLIC_API_BASE_URL` | `https://hireops-api-staging.fly.dev/trpc` — client tRPC for the public apply form |
| `NEXT_PUBLIC_API_BASE` | `https://hireops-api-staging.fly.dev` — client REST (apply upload, offer accept) |

**Server secrets (the portal's in-process router needs these):**

| Var | Required? | Why the portal needs it |
|---|---|---|
| `DATABASE_URL` | **required** | `createServerTRPCCaller` runs procedures against the pooled `sql` client |
| `SUPABASE_KEK_SECRET` | **required** | procedures that decrypt DEKs / credentials (AI drafts, encrypted fields) |
| `SIGNED_LINK_SECRET` | **required** | offer/link procedures generate signed links |
| `SUPABASE_URL` | **required** | storage-touching procedures (resume view, offer letter) |
| `SUPABASE_SERVICE_ROLE_KEY` | **required** | `candidate-uploads` storage reads/writes from server procedures |

> Simplest mental model: **give the portal the same server-secret set as `apps/api`, plus the six `NEXT_PUBLIC_*` vars.** Set each for the **Production** (and Preview, if you use preview URLs) environment.

### 7c. Deploy

Push the branch / click **Deploy**. Or CLI from the repo root:
```bash
vercel --cwd apps/internal-portal          # preview
vercel --cwd apps/internal-portal --prod   # production (staging)
```
After the first deploy, note the assigned URL and feed it back into `NEXT_PUBLIC_SITE_URL` (§7b) and the api's `CORS_ALLOWED_ORIGINS` (§8), then redeploy both.

---

## 8. CORS + cross-origin wiring

The api's CORS allow-list is **already env-driven** — `CORS_ALLOWED_ORIGINS` (comma-separated) in `apps/api/src/index.ts`. No code change needed; just set the secret to the staging portal origin(s):

```bash
fly secrets set -a hireops-api-staging \
  CORS_ALLOWED_ORIGINS="https://hireops-staging.vercel.app"
```
- Include every browser origin that hits the api directly: the portal's production URL, and (if you demo from them) any Vercel preview URLs. Comma-separate.
- When unset the api falls back to the **dev** localhost list — so a missing value won't lock you out locally, but staging **must** set this explicitly or browser calls from the Vercel origin get blocked.
- The api allows methods `GET,POST,OPTIONS` with `credentials:true` — unchanged.

---

## 9. Resend (real email) — owned by the parallel RESEND-01 ticket

Real email delivery is being built in **RESEND-01** (`packages/notifications`). This runbook only wires the env; do **not** duplicate its work here.

On the **workers** app (the sole email sender):
```bash
fly secrets set -a hireops-workers-staging \
  EMAIL_PROVIDER=resend \
  RESEND_API_KEY=re_xxx \
  EMAIL_FROM="HireOps <noreply@staging.hireops.app>"
```
- `EMAIL_FROM` must be a **verified** sender/domain in Resend (DKIM/SPF/DMARC on the sending domain — the DNS side is the user's parallel task).
- Until Resend + DNS are ready, leave `EMAIL_PROVIDER` unset (or `local`): the worker writes rendered mail to `dev_email_outbox` and sends nothing — fine for a dry run of everything except the actual inbox delivery.
- **Email-template gotcha (HANDOVER):** template edits need a **worker restart** to take (`tsx` doesn't hot-reload cross-package `.tsx`), and every template needs the `@jsxRuntime automatic @jsxImportSource react` pragma. On Fly a `fly deploy` restarts the machine, so this only bites if you hot-patch.

---

## 10. Anthropic credential for the demo tenant

AI scoring and agent `draft_message` need a real Anthropic key **stored per-tenant** in `integration_credentials` (encrypted with the tenant DEK) — it is **not** an env var. Alternatively set `AI_CLIENT_MODE=local` everywhere for fixtures (no real Claude), but the demo wants real drafts.

Store it via the exported `storeIntegrationCredential` (`@hireops/db`). Run once against staging (needs `DATABASE_URL` + `SUPABASE_KEK_SECRET` in env), e.g. a throwaway `tsx` invocation:
```ts
// scratch: store-anthropic.ts  (run: pnpm --filter @hireops/db exec tsx store-anthropic.ts)
import { storeIntegrationCredential } from "@hireops/db";
await storeIntegrationCredential({
  tenantId: "<demo-tenant-uuid>",          // the seeded demo tenant
  integrationType: "ai_anthropic",
  secret: process.env.ANTHROPIC_API_KEY!,   // sk-ant-...
  metadata: { note: "staging demo key" },
});
```
The AI client resolves per-tenant (`tenants.settings.ai_provider`, default `anthropic`) and throws if the credential is absent — it never silently swaps providers (cost attribution would lie). Confirm with a triage re-score or an agent draft after storing.

---

## 11. Smoke checklist

Run through the full wedge on the deployed staging stack. Log in at the portal URL (`recruiter1@kyndryl-poc.test` / `TestPassword123!`; `admin1@…` for admin pages).

- [ ] **Login** — `/login` authenticates; JWT carries `tid`/`roles` (if tenant-scoped pages are empty, the §3 hook is off).
- [ ] **Triage** — `/triage` loads Hot Zone + Momentum with seeded candidates (proves the in-process router → staging DB path).
- [ ] **Approvals** — `/approvals` shows the seeded pending approval (Rohan); edit → approve → the send fires.
- [ ] **Admin pages** — `/admin/workflows` (agent list + detail + run history), `/admin/audit` (agent-activity preset, before/after diff), `/admin/costs` (AI usage tiles), `/admin/integrations` (integration health).
- [ ] **Apply form** — `/t/<tenant>/apply/<req>` (public, no auth) submits a résumé → upload lands in `candidate-uploads` → parse + AI score run (proves CORS, storage, `NEXT_PUBLIC_API_BASE*`, the Anthropic credential).
- [ ] **One full wedge cycle** — a stale candidate trips the `stage_stale` scanner (worker) → agent drafts via Claude → appears in `/approvals` → recruiter approves → email dispatches via Resend → `/admin/audit` shows the whole chain.
- [ ] **Email actually delivered** (once §9 is live) — check the recipient inbox, not just `dev_email_outbox`.
- [ ] **Worker health** — `fly logs -a hireops-workers-staging` shows periodic `worker.drain_pass` / `worker.scheduler_tick` with no crash-loop.

---

## Appendix A — quick reference: which env var lives where

| Var | api (Fly) | workers (Fly) | portal (Vercel) | Notes |
|---|:--:|:--:|:--:|---|
| `DATABASE_URL` | ✅ | ✅ | ✅ | transaction pooler 6543 |
| `DIRECT_URL` | — | — | — | migrations only (operator machine) |
| `SUPABASE_URL` | ✅ | — | ✅ | JWKS + storage |
| `SUPABASE_ANON_KEY` | ✅ | — | ✅ (`NEXT_PUBLIC_`) | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | ✅ | storage writes |
| `SUPABASE_KEK_SECRET` | ✅ | ✅ | ✅ | envelope encryption |
| `SIGNED_LINK_SECRET` | ✅ | ✅ | ✅ | signed links |
| `CORS_ALLOWED_ORIGINS` | ✅ | — | — | staging portal origin |
| `NEXT_PUBLIC_SITE_URL` | ✅ | ✅ | ✅ | portal URL (link-building + logout + SA origins) |
| `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_API_BASE` | — | — | ✅ | client → api HTTP |
| `NEXT_PUBLIC_ENV` | — | — | ✅ | `staging` |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` | — | ✅ | — | worker sends email |
| `PORT` | ✅ (`8080`, in fly.toml) | — | — | not a secret |
| `NODE_ENV` | image | fly.toml | Vercel | `production` |
| `LOG_LEVEL` / `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` | opt | opt | opt | observability |
| `AI_CLIENT_MODE` / `KMS_PROVIDER` / `STORAGE_PROVIDER` / `STORAGE_BUCKET` | opt | opt | opt | leave unset for real backends |
| Anthropic key | — | — | — | per-tenant in `integration_credentials` (§10), not env |

## Appendix B — files this runbook depends on

- `apps/api/Dockerfile`, `apps/api/fly.toml`
- `apps/workers/Dockerfile`, `apps/workers/fly.toml`
- `.dockerignore` (repo root)
- `apps/internal-portal/next.config.mjs` (`serverActions.allowedOrigins` now env-derived), `apps/internal-portal/src/app/logout/route.ts` (already env-derived)
- `packages/db/src/migrate.ts` (needs `DIRECT_URL`), `packages/db/src/scripts/seed-*.ts`
- `packages/db/drizzle/migrations/0002…` (auth hook), `0042…` (audit partitions), `0043/0044…` (pii_access_log)
