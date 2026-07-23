/**
 * T2.2 / G07 interview templates seed — a demonstrative DEFAULT interview loop
 * plus ONE custom scorecard for the demo tenant (kyndryl-poc), so
 * /admin/interview-templates lands with a visible loop + custom rubric and a new
 * requisition can APPLY the loop to seed its interview_plans.
 *
 * These are tenant CONFIG rows (like market_benchmarks / candidate_field_policy):
 *   - tenant_scorecard_template: one custom rubric 'delivery_leadership'.
 *   - tenant_interview_round_template: a 3-round loop, the last round using the
 *     custom scorecard. The scorecard is inserted FIRST so the round's key
 *     resolves.
 *
 * Idempotent: fixed UUIDs + ON CONFLICT on the natural keys ((tenant_id,
 * scorecard_key) and (tenant_id, round_number)) — a second run refreshes, never
 * duplicates.
 *
 * Run:
 *   pnpm db:seed:t22
 *
 * Requires: DATABASE_URL in .env, kyndryl-poc tenant, and migrations 0100–0103.
 *
 * Groom-safe by construction: both tables are tenant config — the groom sweep
 * never touches them.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

// Fixed UUIDs (t22 namespace) — idempotent identity for the seeded rows.
const SCORECARD_ID = "f2200000-0000-4000-8000-000000000001";
const ROUND_IDS = [
  "f2200000-0000-4000-8000-000000000011",
  "f2200000-0000-4000-8000-000000000012",
  "f2200000-0000-4000-8000-000000000013",
] as const;

const CUSTOM_SCORECARD = {
  key: "delivery_leadership",
  label: "Delivery leadership",
  criteria: [
    { key: "delivery_track_record", label: "Delivery track record" },
    { key: "team_leadership", label: "Team leadership" },
    { key: "stakeholder_management", label: "Stakeholder management" },
    { key: "strategic_thinking", label: "Strategic thinking" },
    { key: "communication", label: "Communication" },
  ],
};

interface RoundSeed {
  id: string;
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  mode: "video" | "onsite" | "phone";
  scorecardTemplateKey: string;
  competencyFocus: string[];
}

const ROUNDS: RoundSeed[] = [
  {
    id: ROUND_IDS[0],
    roundNumber: 1,
    roundName: "Recruiter screen",
    durationMinutes: 30,
    mode: "phone",
    scorecardTemplateKey: "general",
    competencyFocus: ["communication", "role_fit"],
  },
  {
    id: ROUND_IDS[1],
    roundNumber: 2,
    roundName: "Technical interview",
    durationMinutes: 60,
    mode: "video",
    scorecardTemplateKey: "technical",
    competencyFocus: ["problem_solving", "system_design"],
  },
  {
    id: ROUND_IDS[2],
    roundNumber: 3,
    roundName: "Leadership panel",
    durationMinutes: 45,
    mode: "onsite",
    // Uses the custom rubric seeded above.
    scorecardTemplateKey: CUSTOM_SCORECARD.key,
    competencyFocus: ["ownership", "stakeholder_management"],
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

    // 1) Custom scorecard first (the round loop references it).
    await poolSql`
      INSERT INTO public.tenant_scorecard_template
        (id, tenant_id, scorecard_key, label, criteria, updated_at)
      VALUES
        (${SCORECARD_ID}, ${tid}, ${CUSTOM_SCORECARD.key}, ${CUSTOM_SCORECARD.label},
         ${JSON.stringify(CUSTOM_SCORECARD.criteria)}::jsonb, now())
      ON CONFLICT (tenant_id, scorecard_key) DO UPDATE SET
        label      = EXCLUDED.label,
        criteria   = EXCLUDED.criteria,
        updated_at = now()
    `;
    console.log(
      `  ✓ custom scorecard ${CUSTOM_SCORECARD.key} (${CUSTOM_SCORECARD.criteria.length} criteria)`,
    );

    // 2) The default round loop.
    for (const r of ROUNDS) {
      await poolSql`
        INSERT INTO public.tenant_interview_round_template
          (id, tenant_id, round_number, round_name, duration_minutes, mode,
           scorecard_template_key, competency_focus, updated_at)
        VALUES
          (${r.id}, ${tid}, ${r.roundNumber}, ${r.roundName}, ${r.durationMinutes}, ${r.mode},
           ${r.scorecardTemplateKey}, ${JSON.stringify(r.competencyFocus)}::jsonb, now())
        ON CONFLICT (tenant_id, round_number) DO UPDATE SET
          round_name              = EXCLUDED.round_name,
          duration_minutes        = EXCLUDED.duration_minutes,
          mode                    = EXCLUDED.mode,
          scorecard_template_key  = EXCLUDED.scorecard_template_key,
          competency_focus        = EXCLUDED.competency_focus,
          updated_at              = now()
      `;
      console.log(
        `  ✓ round ${r.roundNumber} ${r.roundName} → ${r.scorecardTemplateKey} (${r.mode})`,
      );
    }

    console.log(`Interview templates seeded into ${TENANT_SLUG} (${tid}).`);
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-t22-interview-templates failed:", err);
  process.exit(1);
});
