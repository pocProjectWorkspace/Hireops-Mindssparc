/**
 * SOLENIS partner-portal login for the "Hudson" partner org.
 *
 * WHY THIS IS A SEPARATE SCRIPT (and not another section of
 * seed-solenis-demo.ts). That seed created partner org "Hudson" (…-400000000001),
 * its live MSA and three assignments, but no partner_users row and no Supabase
 * auth user — so nobody can actually sign into the partner portal as Hudson.
 * Folding the fix into the main seed would have:
 *   1. changed its env contract — the Solenis seed needs only DATABASE_URL today;
 *      creating an auth user needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 *      the repo-root `.env` this file dotenv-loads supplies the OLD staging
 *      project's values. An operator who exported only DATABASE_URL would have
 *      minted the demo login in the WRONG Supabase project, silently; and
 *   2. made "fix the partner login" require a full re-run of the main seed,
 *      which delete-then-reinserts all 34 applications and their transitions to
 *      re-anchor the ageing views.
 * So: a small script, own guards, own --undo.
 *
 * It stays inside the main seed's id namespace (`00000000-0000-4000-9000-…`)
 * with a new row kind 0x43, so `pnpm db:seed:solenis-demo -- --undo` sweeps this
 * row too (it deletes every 9000-prefixed row; and partner_users cascades from
 * partner_orgs regardless). The Supabase AUTH user is not a DB row, so the main
 * seed's undo cannot remove it — use this script's own --undo for that.
 *
 * WHAT IT CREATES (idempotent):
 *   - a Supabase auth user  partner.hudson@example.test / TestPassword123!
 *   - partner_users …-430000000001, role partner_admin, linked to Hudson
 *
 * Partner identity is resolved by DB LOOKUP, not by JWT claims: the Custom
 * Access Token hook only reads tenant_user_memberships, so a partner-only human
 * gets a JWT with a verified `sub` and NO tid/roles. partnerProcedure
 * (apps/api/src/trpc/trpc-core.ts) looks the `sub` up in partner_users and
 * synthesises the claims. Hence: the partner_users row below IS the login.
 *
 * Run:   pnpm db:seed:solenis-partner-login
 * Undo:  pnpm db:seed:solenis-partner-login -- --undo   (drops the row + auth user)
 *
 * Prerequisite: pnpm db:seed:solenis-demo (creates the Hudson org).
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + DATABASE_URL, all three
 * pointing at the Solenis project (enforced below).
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Type-only: erased at compile time, so it cannot disturb the dotenv-before-
// client.ts import ordering the dynamic imports below exist to preserve.
import type { SupabaseClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

/**
 * Host guard, same discipline as seed-solenis-demo.ts but applied to BOTH
 * endpoints. The repo-root `.env` points at the OLD staging database AND the old
 * Supabase project; exported variables win over dotenv, so a forgotten export
 * would otherwise mint this login against the wrong project.
 */
const REQUIRED_HOST_FRAGMENT = "wbjwudtyyblvyirbkrsp";

// ── the login ────────────────────────────────────────────────────────────────
const PARTNER_EMAIL = "partner.hudson@example.test";
const PARTNER_PASSWORD = "TestPassword123!"; // the shared seeded-persona password
const PARTNER_DISPLAY_NAME = "Meera Raghavan";
const PARTNER_ROLE = "partner_admin"; // mirrors the TalentBridge row in seed-partner-demo.ts

// ── ids (seed-solenis-demo.ts's namespace: `<prefix>-<kk><nnnnnnnnnn>`) ──────
// kk 0x40 = partnerOrg (Hudson, created by the main seed), 0x43 = partnerUser,
// which extends that seed's KIND map without colliding (it uses 0x40/0x41/0x42).
const ID_PREFIX = "00000000-0000-4000-9000";
const mkId = (kind: number, n: number): string =>
  `${ID_PREFIX}-${kind.toString(16).padStart(2, "0")}${n.toString(16).padStart(10, "0")}`;

const HUDSON_ORG = mkId(0x40, 1);
const HUDSON_PARTNER_USER = mkId(0x43, 1);

async function main(): Promise<void> {
  const undo = process.argv.includes("--undo");

  const dbUrl = process.env.DATABASE_URL ?? "";
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!dbUrl.includes(REQUIRED_HOST_FRAGMENT) || !supabaseUrl.includes(REQUIRED_HOST_FRAGMENT)) {
    console.error(
      `REFUSING TO RUN: DATABASE_URL and SUPABASE_URL must both name the Solenis ` +
        `project (expected host fragment "${REQUIRED_HOST_FRAGMENT}").\n` +
        `The repo-root .env points at the OLD staging project — export the ` +
        `Solenis env before running this script.`,
    );
    process.exit(2);
  }
  if (!serviceRoleKey) {
    console.error("Missing SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  // Dynamic imports so dotenv (above) loads before client.ts reads DATABASE_URL
  // at module init — the pattern every seed script uses.
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
      console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
      process.exit(2);
    }
    const tid = tenant.id;

    if (undo) {
      await sql`
        DELETE FROM public.partner_users
         WHERE tenant_id = ${tid} AND id = ${HUDSON_PARTNER_USER}
      `;
      console.log(`  ✓ partner_users ${HUDSON_PARTNER_USER} removed`);
      const existingId = await findAuthUserId(admin, sql, PARTNER_EMAIL);
      if (existingId) {
        const del = await admin.auth.admin.deleteUser(existingId);
        if (del.error) console.error(`  ! could not delete auth user: ${del.error.message}`);
        else console.log(`  ✓ auth user ${PARTNER_EMAIL} removed`);
      } else {
        console.log(`  · no auth user ${PARTNER_EMAIL} to remove`);
      }
      return;
    }

    // ── the Hudson org must already exist (main seed's job) ──────────────────
    const [org] = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM public.partner_orgs
       WHERE id = ${HUDSON_ORG} AND tenant_id = ${tid} LIMIT 1
    `;
    if (!org) {
      console.error(
        `partner org ${HUDSON_ORG} (Hudson) not found in ${TENANT_SLUG}. ` +
          `Run pnpm db:seed:solenis-demo first.`,
      );
      process.exit(2);
    }
    console.log(`Provisioning the partner-portal login for "${org.name}" in ${TENANT_SLUG}\n`);

    // ── 1. Supabase auth user ────────────────────────────────────────────────
    // Same idiom as seed-partner-demo.ts (TalentBridge): create, and on
    // "already registered" fall back to a lookup so re-runs are no-ops.
    let authUserId: string | null = null;
    const created = await admin.auth.admin.createUser({
      email: PARTNER_EMAIL,
      password: PARTNER_PASSWORD,
      email_confirm: true,
    });
    if (created.data?.user?.id) {
      authUserId = created.data.user.id;
      console.log(`  ✓ created auth user ${PARTNER_EMAIL} → ${authUserId}`);
    } else {
      authUserId = await findAuthUserId(admin, sql, PARTNER_EMAIL);
      if (!authUserId) {
        console.error(
          `  failed to create or find ${PARTNER_EMAIL}: ${created.error?.message ?? "unknown"}`,
        );
        process.exit(1);
      }
      console.log(`  · reused auth user ${PARTNER_EMAIL} → ${authUserId}`);
    }

    // ── 2. partner_users row (this is what partnerProcedure resolves) ────────
    // uniq_partner_users_tenant_user means one partner identity per auth user per
    // tenant. If some OTHER row already claims this auth user (e.g. one created
    // through the portal's invite flow) the upsert below would fail on that index,
    // so say so plainly instead of dying on a constraint name.
    const [claimedByOther] = await sql<{ id: string }[]>`
      SELECT id FROM public.partner_users
       WHERE tenant_id = ${tid} AND user_id = ${authUserId} AND id <> ${HUDSON_PARTNER_USER}
       LIMIT 1
    `;
    if (claimedByOther) {
      console.error(
        `  auth user ${PARTNER_EMAIL} is already linked to partner_users ${claimedByOther.id} ` +
          `in this tenant. Remove that row (or use a different email) and re-run.`,
      );
      process.exit(1);
    }

    await sql`
      INSERT INTO public.partner_users
        (id, tenant_id, partner_org_id, user_id, full_name, email, role, active, updated_at)
      VALUES (${HUDSON_PARTNER_USER}, ${tid}, ${HUDSON_ORG}, ${authUserId},
              ${PARTNER_DISPLAY_NAME}, ${PARTNER_EMAIL}, ${PARTNER_ROLE}, true, now())
      ON CONFLICT (id) DO UPDATE SET
        partner_org_id = EXCLUDED.partner_org_id,
        user_id = EXCLUDED.user_id,
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        active = true,
        updated_at = now()
    `;
    console.log(
      `  ✓ partner_users ${HUDSON_PARTNER_USER} → ${PARTNER_DISPLAY_NAME} (${PARTNER_ROLE})`,
    );

    console.log("\nPartner portal login:");
    console.log(`  email:    ${PARTNER_EMAIL}`);
    console.log(`  password: ${PARTNER_PASSWORD}`);
    console.log(`  org:      ${org.name}`);
    console.log("  Undo with: pnpm db:seed:solenis-partner-login -- --undo");
  } finally {
    await sql.end({ timeout: 10 });
  }
}

/**
 * Auth user id for an email. The admin API's listUsers is paginated (the
 * TalentBridge seed reads page 1 only), so fall back to auth.users over the
 * service-role pool — same project, no pagination cliff.
 */
async function findAuthUserId(
  admin: SupabaseClient,
  sql: (typeof import("../client"))["sql"],
  email: string,
): Promise<string | null> {
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const hit = (list.data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === email);
  if (hit) return hit.id;
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM auth.users WHERE lower(email) = ${email} LIMIT 1
  `;
  return row?.id ?? null;
}

main()
  .then(() => {
    // The supabase-js admin client keeps a handle alive after listUsers, so an
    // otherwise-clean no-op re-run never exits. Success is decided above;
    // force the exit rather than wait on a client with no close().
    process.exit(0);
  })
  .catch((err) => {
    console.error("seed-solenis-partner-login failed:", err);
    process.exit(1);
  });
