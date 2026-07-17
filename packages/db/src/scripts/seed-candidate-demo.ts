/**
 * CAND-02 demo seed — activates a candidate portal login for the demo person
 * who already holds the extended offer (Priya Subramanian, Person E / …a505),
 * so a fresh-seeded DB demos the full candidate arc:
 *   login → see the extended offer → accept → onboarding case appears (in the
 *   recruiter /onboarding view AND the candidate dashboard) → upload a document.
 *
 * Run:
 *   pnpm db:seed:candidate-demo
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL in .env.
 * Run AFTER db:seed:demo-data (needs Person E …a505 + the extended offer …a5f0).
 *
 * What it creates (idempotent, deterministic id in a FRESH a7xx namespace —
 * NOT the demo seed's a5xx block nor the partner seed's a6xx block):
 *   - a Supabase auth user for Priya's email (priya.subramanian@example.test)
 *   - an ACTIVE candidate_accounts row (…a701) linking that auth user to
 *     Person E, so candidateProcedure resolves her on login.
 *
 * Groom-safe by construction: the groom has NO candidate_accounts residue
 * class, Priya's email is `example.test` (NOT a swept @hireops-dev.local /
 * @onb02.test marker), and Person E is a5xx (doubly protected). Verify with
 * `pnpm db:groom:demo-data` (dry run): zero new residue.
 *
 * Login (documented for the hand-back):
 *   email:    priya.subramanian@example.test
 *   password: TestPassword123!   (the shared dev test-user password)
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
const TEST_PASSWORD = "TestPassword123!";

// Demo person E (Priya) — created by db:seed:demo-data. She carries the
// extended offer …a5f0, and becomes the onboarding case on accept.
const PERSON_E = "00000000-0000-4000-8000-00000000a505";
const CANDIDATE_EMAIL = "priya.subramanian@example.test";

// Deterministic id — a7xx namespace (demo owns a5xx, partner owns a6xx).
const CANDIDATE_ACCOUNT = "00000000-0000-4000-8000-00000000a701";

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  // Dynamic imports so dotenv (above) loads before client.ts reads
  // DATABASE_URL at module init — the pattern every seed script uses.
  const { createClient } = await import("@supabase/supabase-js");
  const { sql: poolSql } = await import("../client");

  try {
    // ── resolve tenant ──────────────────────────────────────────────
    const [tenant] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
      process.exit(2);
    }
    const tid = tenant.id;
    console.log(`Seeding candidate demo into tenant ${TENANT_SLUG} (${tid})`);

    // ── verify Person E exists (demo seed dependency) ───────────────
    const [person] = await poolSql<{ id: string; email: string | null }[]>`
      SELECT id, email_primary AS email FROM public.persons
      WHERE id = ${PERSON_E} AND tenant_id = ${tid} LIMIT 1
    `;
    if (!person) {
      console.error(
        "Demo Person E (Priya, …a505) not found. Run pnpm db:seed:demo-data before this seed.",
      );
      process.exit(2);
    }

    // ── 1. candidate auth user (Supabase) ───────────────────────────
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let authUserId: string | null = null;
    const created = await admin.auth.admin.createUser({
      email: CANDIDATE_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (created.data?.user?.id) {
      authUserId = created.data.user.id;
      console.log(`  created auth user   ${CANDIDATE_EMAIL} → ${authUserId}`);
    } else if (created.error) {
      // "already registered" → look it up.
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existing = list.data?.users.find((x) => x.email === CANDIDATE_EMAIL);
      if (existing) {
        authUserId = existing.id;
        console.log(`  reused auth user    ${CANDIDATE_EMAIL} → ${authUserId}`);
      } else {
        console.error(`  failed to create or find ${CANDIDATE_EMAIL}: ${created.error.message}`);
        process.exit(1);
      }
    }
    if (!authUserId) {
      console.error(`  no auth user id resolved for ${CANDIDATE_EMAIL}`);
      process.exit(1);
    }

    // ── 2. active candidate_accounts row (person-scoped identity) ────
    // ON CONFLICT (tenant_id, person_id): one account per person. A prior run
    // (or a prior activation via the portal) updates in place to ACTIVE, so a
    // second run is a clean no-op and the account survives a demo-data re-seed.
    await poolSql`
      INSERT INTO public.candidate_accounts
        (id, tenant_id, person_id, user_id, status, activated_at)
      VALUES (${CANDIDATE_ACCOUNT}, ${tid}, ${PERSON_E}, ${authUserId}, 'active', now())
      ON CONFLICT (tenant_id, person_id) DO UPDATE
        SET user_id = ${authUserId}, status = 'active', activated_at = now(),
            activation_token_hash = NULL, updated_at = now()
    `;
    console.log(`  candidate_accounts  Priya Subramanian (active)`);

    console.log("\nDone. Candidate login:");
    console.log(`  email:    ${CANDIDATE_EMAIL}`);
    console.log(`  password: ${TEST_PASSWORD}`);
    console.log(`  portal:   /candidate/login`);
    console.log(`  arc:      see extended offer → accept → onboarding docs`);
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
