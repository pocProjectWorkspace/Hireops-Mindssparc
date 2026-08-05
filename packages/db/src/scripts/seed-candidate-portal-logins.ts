/**
 * Candidate portal logins for whoever currently holds an EXTENDED offer.
 *
 * WHY THIS EXISTS. In-portal offer acceptance is built — CandidateOfferCard
 * calls candidateGetMyOffer / candidateAcceptOffer and the candidate dashboard
 * renders it — but it is invisible unless the person logging in is the person
 * holding the offer. Before this script those were disjoint sets: exactly one
 * candidate had a portal account (Priya Subramanian, whose own extended offer
 * had gone and whose application has since moved to offer_accepted), while the
 * candidates holding extended offers had no way to log in at all. A tester
 * signing in as the only candidate who *could* sign in correctly found no offer
 * to accept, and reasonably reported the feature as missing.
 *
 * seed-candidate-demo.ts covers the same ground for ONE hardcoded person from
 * the seed-demo-data fixture set. This one is keyed off the data instead: it
 * finds every candidate with an offer in `extended` and gives them a login. Re-run
 * it after any reseed and it re-points itself at whoever holds an offer now,
 * rather than rotting against a name.
 *
 * Idempotent: an existing auth user is reused, an existing candidate_accounts
 * row is left alone. Safe to run repeatedly.
 *
 * Run: pnpm db:seed:candidate-logins
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auth user creation) and
 * DATABASE_URL. Tenant-guarded to kyndryl-poc.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
/** Same fixed password as the staff personas — see seed-test-users.ts. */
const PASSWORD = "TestPassword123!";

interface Holder {
  person_id: string;
  full_name: string;
  email: string;
  offer_status: string;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const { sql } = await import("../client");
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const [tenant] = await sql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found — refusing to run.`);
      process.exit(2);
    }
    const tid = tenant.id;

    // Whoever holds an extended offer right now. Ordered so the set is stable
    // between runs; email_primary is the login, so a person without one is
    // skipped rather than guessed at.
    const holders = await sql<Holder[]>`
      SELECT DISTINCT p.id AS person_id, p.full_name, p.email_primary AS email, o.status AS offer_status
        FROM public.offers o
        JOIN public.applications a ON a.id = o.application_id AND a.tenant_id = o.tenant_id
        JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = o.tenant_id
        JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = o.tenant_id
       WHERE o.tenant_id = ${tid}
         AND o.status = 'extended'
         AND p.email_primary IS NOT NULL
       ORDER BY p.full_name
    `;

    if (holders.length === 0) {
      console.log("No candidate holds an extended offer — nothing to provision.");
      console.log("Run db:seed:analytics-demo first, which creates the extended offers.");
      return;
    }

    console.log(
      `Provisioning portal logins in ${TENANT_SLUG} for ${holders.length} offer holder(s)\n`,
    );

    const roster = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const byEmail = new Map(
      (roster.data?.users ?? []).map((u) => [(u.email ?? "").toLowerCase(), u] as const),
    );

    for (const h of holders) {
      const email = h.email.toLowerCase();
      let userId = byEmail.get(email)?.id ?? null;

      if (userId) {
        console.log(`  reused auth user ${email}`);
      } else {
        const created = await admin.auth.admin.createUser({
          email,
          password: PASSWORD,
          email_confirm: true,
        });
        if (!created.data?.user?.id) {
          console.error(`  failed to create ${email}: ${created.error?.message ?? "unknown"}`);
          continue;
        }
        userId = created.data.user.id;
        console.log(`  created auth user ${email}`);
      }

      // candidate_accounts.user_id carries no FK, so the auth id is stored as-is.
      // Conflict target is the person: one portal account per candidate.
      await sql`
        INSERT INTO public.candidate_accounts
          (tenant_id, person_id, user_id, status, activated_at, created_at, updated_at)
        VALUES (${tid}, ${h.person_id}, ${userId}, 'active', now(), now(), now())
        ON CONFLICT (tenant_id, person_id) DO UPDATE
          SET user_id = EXCLUDED.user_id, status = 'active', updated_at = now()
      `;
      console.log(`  ✓ ${h.full_name} can now log in and accept their ${h.offer_status} offer`);
    }

    console.log(`\nPassword for all of them: ${PASSWORD}`);
  } finally {
    await sql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-candidate-portal-logins failed:", err);
  process.exit(1);
});
