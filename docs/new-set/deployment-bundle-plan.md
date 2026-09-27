# Deployment bundle — one artefact, provider seams

Date: 26 Sep 2026 · Trigger: Solenis (GCP / Vertex) and the next 4–5 clients will each ask
for "runs in our cloud" or "runs on-prem". Decision proposed here: **do not build two
deployment models. Build one self-hosted bundle and satisfy cloud-specific asks by
substituting managed services behind seams that already exist.** Standardising later on
AWS or GCP is then a hosting decision, not a rewrite.

Not before 8 Oct. Discovery during the deal process; build after signature.

---

## 1. What the platform actually depends on — verified

| Layer | Today | Portable? |
|---|---|---|
| Postgres + RLS + `current_tenant_id()` | Supabase Postgres, transaction pooler `:6543` for runtime, direct `:5432` for migrations | Any Postgres 15+; RLS is plain SQL |
| Auth + JWT claims | Supabase Auth with the `custom_access_token_hook` (tid / tenant_slug / roles), enabled via dashboard toggle | **Supabase-specific.** Self-hosted Supabase supports the hook via `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*` env; anything else (Cognito, Keycloak) is a rewrite of auth + RLS plumbing |
| Object storage | Supabase Storage bucket `candidate-uploads`, signed PUT/GET; `STORAGE_PROVIDER=local` exists for dev | Seam exists; needs an S3-compatible client (GCS, S3, MinIO all speak S3) |
| Key wrapping (DEK/KEK) | `SUPABASE_KEK_SECRET` local wrap; `KMS_PROVIDER=aws` already implemented | Seam exists; add `gcp` |
| API + workers | Node, `apps/api/Dockerfile`, `apps/workers/Dockerfile`; workers is a **singleton** (drains + scheduler assume one instance) | Any container runtime |
| Portals | Next.js on Vercel; **no Dockerfiles** | Need `next start` images + reverse proxy |
| AI | `@hireops/ai-client`: `anthropic`, `openai`, `local`; per-tenant credential in `integration_credentials` (KEK-wrapped); usage metered in `ai_usage_logs` | Seam exists; add `vertex` and `bedrock` (both serve Claude) |
| ASR | `assemblyai`, `deepgram`, `local` | Seam exists; Google STT / on-prem Whisper are adapters |
| Email | `EMAIL_PROVIDER=resend` | Seam exists; add `smtp` (every enterprise has a relay) and `ses` |
| Scheduled work | in-process `scheduler.ts` in workers | Portable (needs the singleton guarantee) |
| CI / migrations | drizzle SQL migrations `0000…0119`, applied by an operator with `DIRECT_URL` | Portable; needs a release train |

The single hard coupling is **Supabase Auth + Storage + the claims hook**. Everything else
is either plain Postgres or already behind a provider switch.

## 2. Three things a client can mean by "run it in our cloud"

Ask this on the first IT call; the answers land in very different places.

| Ask | What it really requires | Effort |
|---|---|---|
| **A. "Our AI must go through Vertex / Bedrock"** (billing, data terms, model governance) | A `vertex` (and `bedrock`) provider in `ai-client`, credential per tenant, same usage log. Claude is available on both. The app keeps running wherever it is hosted. | **Days** |
| **B. "Data must stay in India / in our region"** | Supabase project in the right region (Solenis is currently **ap-southeast-1 Singapore, not Mumbai**), storage bucket in region, ASR vendor region flag (AssemblyAI has an EU endpoint; check India). | **Hours**, plus a migration if the project already has data |
| **C. "The whole application runs inside our tenancy"** (GCP project, AWS account, or on-prem) | The bundle in §3, deployed by us into their environment, plus managed substitutions where their security team requires. | **Weeks** (first client), days thereafter |

Solenis's own answer in the questionnaire was "restricted to local leadership view" and "no
integrations today" — that reads as A + B, not C. Confirm before sizing C.

## 3. The bundle

One versioned artefact per release: `hireops-bundle-vX.Y.Z` containing

```
compose.yaml / helm chart
  supabase/         self-hosted Supabase (Postgres, GoTrue with the claims hook baked
                    into config, Storage, Kong) — the ONLY zero-code-change path
  api/              apps/api image
  workers/          apps/workers image, replicas fixed at 1
  internal-portal/  Next.js `next start` image  (NEW Dockerfile)
  partner-portal/   Next.js `next start` image  (NEW Dockerfile)
  proxy/            Caddy or nginx: TLS, the two portal hosts, /api, CORS
  migrate/          one-shot job: `pnpm db:migrate` against DIRECT_URL, runs before api
  seed/             optional one-shot: test users + tenant bootstrap
env/
  hireops.env.example   the runbook Appendix A matrix, one file, commented
  client-manifest.yaml  per-client values: region, providers chosen, domains, retention
smoke/
  persona-sweep.ts      the 12-persona cookie-auth probe from the 30 Aug dry run
  healthz + hook diagnose (db:diagnose:hook)
```

Runs unchanged on: a client VM (on-prem), a GCP Compute Engine VM or GKE namespace, an AWS
EC2/EKS, or Mindssparc's own account. **This is the on-prem model and the "cloud-specific"
model at once.**

## 4. Managed substitutions (only when a client's security team requires them)

Each is an implementation behind an existing seam. None forks the bundle.

| Seam | GCP | AWS | Notes |
|---|---|---|---|
| AI | Vertex AI (Claude) | Bedrock (Claude) | Same prompts, same schemas, same `ai_usage_logs`; pricing table gains provider rows |
| KMS | Cloud KMS | AWS KMS (exists) | `KMS_PROVIDER=gcp` |
| Storage | GCS via S3-compat | S3 | `STORAGE_PROVIDER=s3` with endpoint override covers GCS, S3 and MinIO |
| Email | SMTP relay / SendGrid | SES | `EMAIL_PROVIDER=smtp` first — it satisfies every enterprise |
| Postgres | Cloud SQL | RDS | Only if they refuse the bundled Postgres; self-hosted Supabase can point GoTrue/Storage at an external Postgres |
| Auth | — | — | **Stay on self-hosted GoTrue.** Cognito / Entra as the *identity provider* is fine (GoTrue does OIDC SSO); replacing GoTrue as the *token issuer* is the rewrite to refuse |
| ASR | Google STT | Transcribe | Adapter each; or keep AssemblyAI/Deepgram via their regional endpoints |

## 5. Build sequence

- **DB-0 Discovery template** (during the deal): the three-question sheet in §2 plus the
  security questionnaire answers (SSO provider, egress rules, secrets manager, backup
  policy, log retention). Half a day to write; reused per client.
- **DB-1 Vertex + Bedrock AI providers** (~3 days). Provider enum, per-tenant credential
  shape (service-account JSON / IAM role), pricing rows, local fixture mode, one
  end-to-end test each. Ship this **during** the Solenis deal as the visible proof.
- **DB-2 Portal Dockerfiles + proxy** (~2 days). `output: "standalone"` Next builds, Caddy
  with the two hosts, health endpoints. Prove on a single VM.
- **DB-3 Self-hosted Supabase profile** (~4 days). Compose from the upstream self-hosting
  kit, claims hook configured via GoTrue env (no dashboard toggle), bucket created by init
  job, `db:diagnose:hook` in the smoke. This is where the unknown unknowns live; budget
  slack.
- **DB-4 Migrate + seed jobs, client manifest, smoke** (~2 days). One-shot containers;
  `persona-sweep` reads the manifest.
- **DB-5 SMTP + S3-compatible storage providers** (~3 days). Covers GCS, S3, MinIO.
- **DB-6 Release train** (~2 days). Tagged bundle per release, changelog, migration
  notes, upgrade runbook (`migrate` job then rolling api/workers/portals), rollback =
  previous tag + migration down-notes where destructive.
- **DB-7 GCP-managed profile** (only if Solenis requires it, ~3 days): Cloud KMS
  provider, Cloud SQL wiring, Workload Identity for Vertex.

Roughly four weeks of one executor for DB-1…DB-6, sequenced after signature except DB-1.

## 6. What this costs you as a business — price it, do not absorb it

- Every self-hosted client is an **ops commitment**: upgrades on the release train,
  migration windows, their SMTP and SSO, their backup policy, their outage calls. Put a
  managed-service line in the licence.
- Minimum you require from the client: a VM or K8s namespace with the sizing sheet, a
  DNS pair, an SMTP relay, outbound HTTPS to the AI provider (or their Vertex/Bedrock
  endpoint), and a named admin. No minimum, no on-prem.
- **Version skew** across clients is the real long-term cost. The release train and the
  smoke sweep exist to keep it linear; refuse client-specific forks.
- Workers singleton is a scaling ceiling per client; fine to ~300 hires/month per the
  architecture sizing, and it is per-tenant deployment anyway.

## 7. Standardising after client six

By then the bundle has run on-prem, on GCP and on AWS. Pick the cloud where most clients
sit, host the multi-tenant SaaS edition there from the **same bundle** with managed
substitutions, and keep the bundle as the on-prem/regulated offering. Nothing is thrown
away; the seams are the product.

## 8. Decisions needed

1. Confirm with Solenis IT which of A / B / C they mean (and flip the Supabase region to
   Mumbai regardless).
2. Approve DB-1 (Vertex + Bedrock) as deal-process work, visible to Solenis.
3. Agree the managed-service pricing line and the client minimums before the first
   on-prem conversation.
4. Owner for the self-hosted Supabase spike (DB-3) — it needs uninterrupted days.
