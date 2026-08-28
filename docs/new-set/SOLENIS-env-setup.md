# Solenis pilot environment — setup checklist (28 Aug 2026)

Decision of record: replicate the current architecture as-is into a fully
separate environment — fresh Supabase (ap-south-1, Pro), fresh Railway project
(api + workers), fresh Vercel projects (both portals). AWS/Mindssparc-account
hosting deferred post-pilot. Source runbook: `staging-runbook.md` (Fly→Railway).
Deploy from `main` @ `af85e06` (PR #3 — N4 + configurability slice included).

## Order of operations
Supabase project → migrations → auth hook (dashboard) → bucket → secrets →
Railway api+workers → Vercel portals → DNS/CORS → seeds → branding → Solenis
data mapping → smoke.

## 1. Supabase (human creates; agent drives the rest)
- New project, region **ap-south-1 (Mumbai)**, **Pro tier** (free tier pauses;
  pause ALSO silently resets the auth-hook registration — runbook §3 gotcha).
- Collect: project URL, anon key, service-role key, **transaction pooler
  connection string (:6543)** = runtime `DATABASE_URL`, **direct connection
  string (:5432)** = `DIRECT_URL` (migrations only, operator machine).
- Migrations (operator machine, Node 22 prefix):
  `export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"`
  `.env` with the NEW `DATABASE_URL` + `DIRECT_URL` + `SUPABASE_KEK_SECRET`,
  then `pnpm db:migrate` (all migrations, 0000→0118+).
- **Auth hook — dashboard, DO NOT SKIP**: Authentication → Hooks → Customize
  Access Token (JWT) Claims → on, Postgres, schema `public`, function
  `custom_access_token_hook`, Save, wait ~60s. Verify with
  `pnpm db:diagnose:hook`. (Miss this = logins work, every query empty.)
- Storage: create bucket `candidate-uploads` (private).
- Generate secrets (once, store only in Railway/Vercel env):
  `openssl rand -hex 32`  → `SUPABASE_KEK_SECRET` (64-hex)
  `openssl rand -hex 32`  → `SIGNED_LINK_SECRET`

## 2. Railway (human creates project + two services from the GitHub repo)
- Service **api**: Dockerfile `apps/api/Dockerfile`, port 8080.
- Service **workers**: Dockerfile `apps/workers/Dockerfile`.
  **SINGLETON — exactly 1 replica, never scale up** (drains + scheduler assume it).
- Env per runbook §6a (paste-ready once values exist):
  - api: DATABASE_URL (pooler :6543), SUPABASE_URL, SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY, SUPABASE_KEK_SECRET, SIGNED_LINK_SECRET,
    CORS_ALLOWED_ORIGINS (both portal origins, comma-sep),
    NEXT_PUBLIC_SITE_URL (internal portal URL), NODE_ENV=production, PORT=8080.
  - workers: DATABASE_URL, SUPABASE_KEK_SECRET, SIGNED_LINK_SECRET,
    NEXT_PUBLIC_SITE_URL, EMAIL_PROVIDER=resend, RESEND_API_KEY, EMAIL_FROM,
    NODE_ENV=production. (No SUPABASE_URL/keys — talks Postgres directly.)
  - Leave unset for real backends: AI_CLIENT_MODE, STORAGE_PROVIDER, KMS_PROVIDER.
- Railway deploys are MANUAL here (house habit): deploy api first, then workers.

## 3. Vercel (two new projects, same repo)
- internal-portal: root `apps/internal-portal`; env: NEXT_PUBLIC_SUPABASE vars
  (URL + anon as NEXT_PUBLIC_), SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL,
  SUPABASE_KEK_SECRET, SIGNED_LINK_SECRET, NEXT_PUBLIC_SITE_URL (its own URL),
  NEXT_PUBLIC_API_BASE_URL (api URL), NEXT_PUBLIC_ENV=solenis-pilot.
  (Exact NEXT_PUBLIC_ names: copy from the existing staging Vercel project —
  fastest and drift-proof.)
- partner-portal: root `apps/partner-portal`, same shape, its own URLs.
- Redeploy gotcha from the 5 Aug fix round: if a portal build inexplicably
  no-ops, remember the Turbo full-cache-hit vs `.next/cache` ENOENT trap —
  see hireops-demo-fix-round memory (3-gotcha redeploy incantation).

## 4. DNS (GoDaddy) + CORS
- `solenis.hireops-ai.com` → internal portal (Vercel CNAME)
- `partners-solenis.hireops-ai.com` → partner portal (Vercel CNAME)
- `api-solenis.hireops-ai.com` → Railway api (CNAME to Railway domain)
- Then set CORS_ALLOWED_ORIGINS on api to the two portal https origins and
  NEXT_PUBLIC_SITE_URL everywhere to the internal-portal origin.

## 5. Seeds (fresh DB, no CI here, order still matters)
`db:seed:test-users` → `db:seed:benchmarks` → `db:seed:demo-data` →
`db:seed:partner-demo` → `db:seed:candidate-demo` → `db:seed:offboard-demo` →
`db:seed:hr-policies` → analytics seed (see hireops-seed-analytics-task).
Then Anthropic credential for the demo tenant via the internal UI (runbook §10).

## 6. Solenis specifics (day 2)
- Branding: tenant display_name + settings.branding (logo URL, primary colour)
  via /admin/branding. Need: logo asset + hex from Solenis/solenis.com.
- Requisitions from the 3 JDs in `public/solenis demo data/` (GBS roles, INR
  comp bands).
- Questionnaire (.eml) + onboarding form (https://forms.office.com/r/vyCa7QCgqg)
  → tenant config: SLA hours, approval routing, business units, comp bands,
  claim window, alert lead time, audio retention.
- Market benchmarks CURATED TO THEIR GBS/transformation role titles (market
  intel is the buying feature — generic tech rows undercut the demo).
- Partner orgs need an MSA agreed via internal UI or Commercials shows empty.
- Demo personas staged to their org shape (@mindssparc.com logins preserved).

## 7. Smoke — runbook §11 checklist end-to-end, on the new domains.
