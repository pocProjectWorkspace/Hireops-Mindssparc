/**
 * PARTNER-01 demo seed — provisions ONE empanelled sourcing partner in the
 * kyndryl-poc tenant so the partner portal (apps/partner-portal) has a real
 * org to log in as and a populated dashboard.
 *
 * Run:
 *   pnpm db:seed:partner-demo
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL in .env.
 * Run AFTER db:seed:test-users (needs recruiter1's membership) and
 * db:seed:demo-data (assignment #1 targets the demo requisition …a5c0).
 *
 * What it creates (all idempotent, deterministic ids in a FRESH a6xx
 * namespace — NOT the demo seed's a5xx block, which the groom protects):
 *   - partner_orgs  "TalentBridge Partners" (tier empanelled)      …a601
 *   - a Supabase auth user + partner_users row (role partner_admin) …a602
 *   - a SECOND requisition (…a6c0) reusing the demo BU + envelope so the
 *     dashboard shows two distinct assigned-req cards. The demo seed ships
 *     only ONE requisition (…a5c0); the ticket asks for two assignments, so
 *     the seed supplies the second req itself rather than edit seed-demo-data.
 *   - two partner_assignments: …a611 → demo req …a5c0, …a612 → …a6c0
 *
 * Groom-safe by construction: no a5xx ids, no @hireops-dev.local /
 * @onb02.test emails, no persons/candidates/onboarding rows — nothing the
 * groom's residue classes match. Verify with `pnpm db:groom:demo-data`
 * (dry run): the partner rows must classify as ZERO residue.
 *
 * Login (documented for the hand-back):
 *   email:    partner1@talentbridge-partners.test
 *   password: TestPassword123!   (the shared dev test-user password)
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
const RECRUITER_EMAIL = "recruiter1@kyndryl-poc.test";
const TEST_PASSWORD = "TestPassword123!";

// Partner login (credible partner domain — deliberately NOT @hireops-dev.local
// or @onb02.test, which the groom sweeps).
const PARTNER_EMAIL = "partner1@talentbridge-partners.test";
const PARTNER_DISPLAY_NAME = "Asha Menon";
const PARTNER_ORG_NAME = "TalentBridge Partners";

// Deterministic ids — a6xx namespace (the demo seed owns a5xx; the groom
// protects a5xx and would refuse if we reused it).
const PARTNER_ORG = "00000000-0000-4000-8000-00000000a601";
const PARTNER_USER = "00000000-0000-4000-8000-00000000a602";
const SECOND_POSITION = "00000000-0000-4000-8000-00000000a6a0";
const SECOND_JD = "00000000-0000-4000-8000-00000000a6d0";
const SECOND_REQ = "00000000-0000-4000-8000-00000000a6c0";
const ASSIGN_1 = "00000000-0000-4000-8000-00000000a611";
const ASSIGN_2 = "00000000-0000-4000-8000-00000000a612";

// Reused demo-seed ids (created by db:seed:demo-data).
const DEMO_BU = "00000000-0000-4000-8000-00000000a5b0";
const DEMO_ENVELOPE = "00000000-0000-4000-8000-00000000a5e0";
const DEMO_REQ = "00000000-0000-4000-8000-00000000a5c0";

const SECOND_JD_BODY = `# Staff Frontend Engineer

We're hiring a Staff Frontend Engineer for the GCC platform team in
Bengaluru. You'll own the design-system and app-shell layer that every
internal product builds on.

## Must-have
- React 18, TypeScript, Next.js App Router
- Design systems / component libraries at scale
- Accessibility (WCAG 2.1 AA) and performance budgets

## Good-to-have
- Node/tRPC, Storybook, visual regression tooling
`;

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
    console.log(`Seeding partner demo into tenant ${TENANT_SLUG} (${tid})`);

    // ── resolve recruiter membership (owns the second req) ──────────
    const [recruiter] = await poolSql<{ id: string }[]>`
      SELECT tum.id FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${tid} AND tum.status = 'active' AND au.email = ${RECRUITER_EMAIL}
      LIMIT 1
    `;
    if (!recruiter) {
      console.error(
        `recruiter ${RECRUITER_EMAIL} not found in ${TENANT_SLUG}. Run pnpm db:seed:test-users first.`,
      );
      process.exit(2);
    }
    const recruiterId = recruiter.id;

    // ── verify the demo BU + envelope + req exist (demo seed dependency) ──
    const [demoReq] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.requisitions WHERE id = ${DEMO_REQ} AND tenant_id = ${tid} LIMIT 1
    `;
    const [demoBu] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.business_units WHERE id = ${DEMO_BU} AND tenant_id = ${tid} LIMIT 1
    `;
    if (!demoReq || !demoBu) {
      console.error(
        "Demo requisition/business-unit not found. Run pnpm db:seed:demo-data before this seed.",
      );
      process.exit(2);
    }

    // ── 1. partner org ──────────────────────────────────────────────
    await poolSql`
      INSERT INTO public.partner_orgs
        (id, tenant_id, name, tier, primary_contact_email, active, onboarded_at)
      VALUES (${PARTNER_ORG}, ${tid}, ${PARTNER_ORG_NAME}, 'empanelled',
              ${PARTNER_EMAIL}, true, now() - interval '30 days')
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`  partner_orgs        ${PARTNER_ORG_NAME} (${PARTNER_ORG})`);

    // ── 2. partner auth user (Supabase) + partner_users row ─────────
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let authUserId: string | null = null;
    const created = await admin.auth.admin.createUser({
      email: PARTNER_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (created.data?.user?.id) {
      authUserId = created.data.user.id;
      console.log(`  created auth user   ${PARTNER_EMAIL} → ${authUserId}`);
    } else if (created.error) {
      // "already registered" → look it up.
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existing = list.data?.users.find((x) => x.email === PARTNER_EMAIL);
      if (existing) {
        authUserId = existing.id;
        console.log(`  reused auth user    ${PARTNER_EMAIL} → ${authUserId}`);
      } else {
        console.error(`  failed to create or find ${PARTNER_EMAIL}: ${created.error.message}`);
        process.exit(1);
      }
    }
    if (!authUserId) {
      console.error(`  no auth user id resolved for ${PARTNER_EMAIL}`);
      process.exit(1);
    }

    await poolSql`
      INSERT INTO public.partner_users
        (id, tenant_id, partner_org_id, user_id, full_name, email, role, active)
      VALUES (${PARTNER_USER}, ${tid}, ${PARTNER_ORG}, ${authUserId},
              ${PARTNER_DISPLAY_NAME}, ${PARTNER_EMAIL}, 'partner_admin', true)
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`  partner_users       ${PARTNER_DISPLAY_NAME} (partner_admin)`);

    // ── 3. second requisition (reuses demo BU + envelope) ───────────
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
      VALUES (${SECOND_POSITION}, ${tid}, ${DEMO_BU}, 'Staff Frontend Engineer',
              'hybrid', 'Bengaluru', true)
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${SECOND_JD}, ${tid}, ${SECOND_POSITION}, 1, ${SECOND_JD_BODY}, 'approved')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
         primary_recruiter_id, hiring_manager_id, status, number_of_openings,
         target_start_date, is_public, public_slug, posted_at)
      VALUES (${SECOND_REQ}, ${tid}, ${SECOND_POSITION}, ${SECOND_JD}, ${DEMO_ENVELOPE},
              ${recruiterId}, ${recruiterId}, 'posted', 2,
              (now() + interval '45 days')::date,
              true, 'gcc-blr-staff-frontend', now() - interval '5 days')
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`  requisitions        Staff Frontend Engineer (${SECOND_REQ})`);

    // ── 4. two active assignments ───────────────────────────────────
    await poolSql`
      INSERT INTO public.partner_assignments
        (id, tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status)
      VALUES (${ASSIGN_1}, ${tid}, ${PARTNER_ORG}, ${DEMO_REQ}, ${recruiterId}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.partner_assignments
        (id, tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status)
      VALUES (${ASSIGN_2}, ${tid}, ${PARTNER_ORG}, ${SECOND_REQ}, ${recruiterId}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`  partner_assignments 2 active (→ ${DEMO_REQ}, → ${SECOND_REQ})`);

    console.log("\nDone. Partner login:");
    console.log(`  email:    ${PARTNER_EMAIL}`);
    console.log(`  password: ${TEST_PASSWORD}`);
    console.log(`  org:      ${PARTNER_ORG_NAME}`);
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
