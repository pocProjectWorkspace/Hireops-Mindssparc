# Solenis tenant slug rename — `kyndryl-poc` → `solenis`

Why: the public apply URL is `/t/{tenants.slug}/apply/{publicSlug}`, so every Solenis
posting currently reads `solenis.hireops-ai.com/t/kyndryl-poc/apply/…`. The slug is only
read live from `tenants.slug` (apply resolver, JWT hook, partner/candidate contexts) and
from `auth.users.raw_user_meta_data.tenant_slug` (the hook's "desired tenant" hint). It is
not persisted in any other table. Renaming both is safe; live sessions must sign in again.

Run against the **Solenis** database only (host fragment `wbjwudtyyblvyirbkrsp`). Use the
direct connection string (`:5432`), not the pooler.

## 0. Pre-checks

```sql
SELECT id, slug, display_name, status FROM public.tenants;
SELECT count(*) AS users_with_hint
  FROM auth.users WHERE raw_user_meta_data->>'tenant_slug' = 'kyndryl-poc';
SELECT count(*) AS memberships FROM public.tenant_user_memberships WHERE status = 'active';
```
Expect exactly one tenant row with slug `kyndryl-poc`.

## 1. Rename (one transaction)

```sql
BEGIN;
UPDATE public.tenants SET slug = 'solenis', updated_at = now()
 WHERE slug = 'kyndryl-poc';
UPDATE auth.users
   SET raw_user_meta_data = jsonb_set(raw_user_meta_data, '{tenant_slug}', '"solenis"')
 WHERE raw_user_meta_data->>'tenant_slug' = 'kyndryl-poc';
COMMIT;
```

## 2. Verify

```sql
SELECT slug FROM public.tenants;                                   -- solenis
SELECT count(*) FROM auth.users
 WHERE raw_user_meta_data->>'tenant_slug' = 'kyndryl-poc';         -- 0
```
Then `pnpm db:diagnose:hook` with the Solenis env exported (Node 22 prefix) — the hook
must still resolve `tid` + `tenant_slug` for a test login.

## 3. Environment

- Vercel `solenis-portal` (production): add `NEXT_PUBLIC_DEFAULT_TENANT_SLUG=solenis`,
  redeploy (candidate login defaults to this slug when no `?tenant=` is in the URL).
- Any future seed run against Solenis: `export HIREOPS_TENANT_SLUG=solenis` first
  (SAT-AM-01 made every seed script read this; default stays `kyndryl-poc` for old staging).
- Railway api/workers: nothing to change.

## 4. Smoke

```
curl -s -o /dev/null -w '%{http_code}\n' https://solenis.hireops-ai.com/t/solenis/apply/solenis-hyd-tableau-analyst      # 200
curl -s -o /dev/null -w '%{http_code}\n' https://solenis.hireops-ai.com/t/kyndryl-poc/apply/solenis-hyd-tableau-analyst  # 404
```
Sign in as each persona once (internal, partner, candidate) — old sessions carry the old
`tenant_slug` claim until refreshed. Open a requisition detail page and confirm the copied
apply link shows `/t/solenis/`.

## Rollback

Same transaction with the two literals swapped.
