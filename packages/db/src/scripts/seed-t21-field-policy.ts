/**
 * T2.1 / G05 required-candidate-field policy seed — a demonstrative override for
 * the demo tenant (kyndryl-poc) so /admin/candidate-fields lands with a visible
 * non-default row and the recruiter's Missing Info tracker reflects it.
 *
 * These are CONFIG rows over the fixed seven-field Missing-Info CATALOG (the code
 * constant in apps/api/src/lib/missing-info.ts) — a tenant's requiredness/gate
 * override, not new fields. Keyed on (tenant_id, field_key); a second run
 * refreshes the row, never duplicates.
 *
 * DEMONSTRATIVE CHANGE (kept gate-safe on purpose):
 *   - education_year: optional → REQUIRED, blocks_advance_stage = NULL. The code
 *     default is optional/ungated; making it required visibly changes the
 *     tracker (education_year now shows as a required field) WITHOUT adding a hard
 *     advancement gate (a null gate never blocks a transition). This proves the
 *     override drives the display without altering demo advancement behaviour.
 *
 * The other six catalog fields are intentionally left on the code default, so
 * this seed is additive and minimal.
 *
 * Run:
 *   pnpm db:seed:t21
 *
 * Requires: DATABASE_URL in .env, and the kyndryl-poc tenant (db:migrate).
 *
 * Groom-safe by construction: candidate_field_policy is tenant config (like
 * market_benchmarks / tenant_application_sources) — the groom sweep never touches
 * it.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

interface PolicySeed {
  fieldKey: string;
  requiredness: "required" | "optional";
  blocksAdvanceStage: string | null;
}

const POLICIES: PolicySeed[] = [
  {
    fieldKey: "education_year",
    requiredness: "required",
    blocksAdvanceStage: null,
  },
];

async function main(): Promise<void> {
  const { sql: poolSql } = await import("../client");

  try {
    const [tenant] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
      process.exit(2);
    }
    const tid = tenant.id;
    console.log(
      `Seeding ${POLICIES.length} candidate-field policy row(s) into ${TENANT_SLUG} (${tid})`,
    );

    for (const p of POLICIES) {
      await poolSql`
        INSERT INTO public.candidate_field_policy
          (tenant_id, field_key, requiredness, blocks_advance_stage, updated_at)
        VALUES
          (${tid}, ${p.fieldKey}, ${p.requiredness}, ${p.blocksAdvanceStage}, now())
        ON CONFLICT (tenant_id, field_key) DO UPDATE SET
          requiredness         = EXCLUDED.requiredness,
          blocks_advance_stage = EXCLUDED.blocks_advance_stage,
          updated_at           = now()
      `;
      console.log(
        `  ✓ ${p.fieldKey} → ${p.requiredness}${
          p.blocksAdvanceStage ? ` (blocks ${p.blocksAdvanceStage})` : " (tracked, no gate)"
        }`,
      );
    }

    console.log("Candidate-field policy seeded.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-t21-field-policy failed:", err);
  process.exit(1);
});
