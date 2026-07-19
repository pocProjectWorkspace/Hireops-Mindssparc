/**
 * RO-02 demo seed — a requisition parked MID-WIZARD.
 *
 * Standalone + additive (not folded into seed-demo-data.ts, to keep the
 * merge surface small on the shared DB). Creates ONE draft requisition whose
 * JD is generated and whose skills are weighted (with the RO-02 additive
 * fields: category / min_years / notes) but which has NOT been submitted — so
 * the demo can open the wizard v2 on it (`/requisitions/new?rid=<id>&step=...`)
 * and show it resuming at the Skill-weighting / Review steps.
 *
 * Distinct id namespace: a5c0… (a5b0 = position/jd, a5c0 = requisition), all in
 * the free a5b/a5c slots of the demo tenant's a5xx range. Idempotent — every
 * write is ON CONFLICT-guarded and the requisition UPSERTs back to `draft`, so
 * a re-seed resets it. Run once (kill + retry once on a pooler hang).
 *
 * Runbook: `pnpm db:seed:ro-02` (root passthrough). Requires the demo tenant
 * (db:migrate + db:seed:test-users first, for the hiringmanager1 membership).
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
const HIRING_MANAGER_EMAIL = "hiringmanager1@kyndryl-poc.test";

// a5b/a5c namespace (free — a5a0..a599 are used by seed-demo-data).
const RO2_BU = "00000000-0000-4000-8000-00000000a5b0";
const RO2_POSITION = "00000000-0000-4000-8000-00000000a5b1";
const RO2_JD = "00000000-0000-4000-8000-00000000a5b2";
const RO2_REQ = "00000000-0000-4000-8000-00000000a5c0";

interface SeedSkill {
  name: string;
  category: string;
  weight: string; // numeric text
  required: boolean;
  minYears: number | null;
  notes: string | null;
}

const SKILLS: SeedSkill[] = [
  {
    name: "Java",
    category: "Languages",
    weight: "9.00",
    required: true,
    minYears: 5,
    notes: "Core to the payments platform.",
  },
  {
    name: "Spring Boot",
    category: "Frameworks",
    weight: "8.00",
    required: true,
    minYears: 4,
    notes: null,
  },
  {
    name: "Kafka",
    category: "Infrastructure",
    weight: "7.00",
    required: true,
    minYears: 3,
    notes: "Event-streaming depth expected.",
  },
  {
    name: "PostgreSQL",
    category: "Databases",
    weight: "6.00",
    required: true,
    minYears: 3,
    notes: null,
  },
  {
    name: "Kubernetes",
    category: "Infrastructure",
    weight: "5.00",
    required: false,
    minYears: 2,
    notes: "Nice to have.",
  },
];

const JD_SECTIONS = {
  summary:
    "A senior backend engineer role owning the reliability and evolution of the payments platform for the GCC. You will design event-driven services and mentor a growing team.",
  responsibilities: [
    "Design, build, and operate high-throughput backend services.",
    "Own event-streaming pipelines and their reliability.",
    "Mentor engineers and raise the team's engineering bar.",
  ],
  requirements: [
    "5+ years building production backend systems in Java.",
    "Strong distributed-systems fundamentals.",
    "Experience operating services in production.",
  ],
  niceToHave: ["Payments or fintech domain exposure."],
  toolsTech: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "Kubernetes"],
  education: [],
  softSkills: ["Clear written communication", "Mentorship"],
};

function composeJdText(): string {
  const lines: string[] = [
    "# Senior Backend Engineer",
    "",
    JD_SECTIONS.summary,
    "",
    "## Responsibilities",
    ...JD_SECTIONS.responsibilities.map((r) => `- ${r}`),
    "",
    "## Requirements",
    ...JD_SECTIONS.requirements.map((r) => `- ${r}`),
    "",
    "## Nice to have",
    ...JD_SECTIONS.niceToHave.map((r) => `- ${r}`),
    "",
    "## Tools & technology",
    ...JD_SECTIONS.toolsTech.map((r) => `- ${r}`),
    "",
    "## Soft skills",
    ...JD_SECTIONS.softSkills.map((r) => `- ${r}`),
  ];
  return lines.join("\n");
}

async function main() {
  const { db, sql: poolSql } = await import("../client");
  const { tenants } = await import("../schema");
  const { eq } = await import("drizzle-orm");

  try {
    const [tenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, TENANT_SLUG))
      .limit(1);
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found; run db:migrate + db:seed:test-users first.`);
      process.exit(2);
    }
    const tid = tenant.id;

    const [hm] = await poolSql<{ id: string }[]>`
      SELECT tum.id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${tid} AND au.email = ${HIRING_MANAGER_EMAIL}
      LIMIT 1
    `;
    if (!hm) {
      console.error(
        `hiring manager ${HIRING_MANAGER_EMAIL} membership not found; run db:seed:test-users.`,
      );
      process.exit(2);
    }
    const hmId = hm.id;

    // Business unit
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${RO2_BU}, ${tid}, 'RO-02 Payments GCC', 'ro-02-payments-gcc')
      ON CONFLICT (id) DO NOTHING
    `;

    // Position (with INR budget band)
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, level, location_type, primary_location,
         comp_band_min, comp_band_max, comp_currency, hiring_manager_id, created_by, is_active)
      VALUES (${RO2_POSITION}, ${tid}, ${RO2_BU}, 'Senior Backend Engineer', 'Senior', 'hybrid',
              'Bengaluru', 2800000::numeric, 4200000::numeric, 'INR', ${hmId}, ${hmId}, true)
      ON CONFLICT (id) DO NOTHING
    `;

    // Draft JD version carrying the structured sections in ai_metadata.
    const jdText = composeJdText();
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, status, jd_text, summary, ai_metadata, created_by)
      VALUES (${RO2_JD}, ${tid}, ${RO2_POSITION}, 1, 'draft', ${jdText}, ${JD_SECTIONS.summary},
              ${JSON.stringify({ sections: JD_SECTIONS, seeded: "ro-02" })}::jsonb, ${hmId})
      ON CONFLICT (id) DO UPDATE SET
        jd_text = EXCLUDED.jd_text, summary = EXCLUDED.summary,
        ai_metadata = EXCLUDED.ai_metadata, status = 'draft', updated_at = now()
    `;

    // Skills — replace-set (delete-then-insert) with the RO-02 additive fields.
    await poolSql`DELETE FROM public.jd_skills WHERE tenant_id = ${tid} AND jd_version_id = ${RO2_JD}`;
    for (const s of SKILLS) {
      await poolSql`
        INSERT INTO public.jd_skills
          (tenant_id, jd_version_id, skill_name, category, weight, is_required,
           min_years_experience, notes)
        VALUES (${tid}, ${RO2_JD}, ${s.name}, ${s.category}, ${s.weight}::numeric, ${s.required},
                ${s.minYears}, ${s.notes})
      `;
    }

    // Requisition — draft, self-assigned to the hiring manager. UPSERT back to
    // draft so a re-seed resets a mid-demo advance.
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id,
         status, number_of_openings, target_start_date, is_public, created_by)
      VALUES (${RO2_REQ}, ${tid}, ${RO2_POSITION}, ${RO2_JD}, ${hmId}, ${hmId},
              'draft', 2, (now() + interval '45 days')::date, false, ${hmId})
      ON CONFLICT (id) DO UPDATE SET status = 'draft', updated_at = now()
    `;
    await poolSql`
      INSERT INTO public.requisition_state_transitions
        (tenant_id, requisition_id, from_status, to_status, transitioned_by, reason)
      SELECT ${tid}, ${RO2_REQ}, NULL, 'draft', ${hmId}, 'RO-02 mid-wizard demo seed'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.requisition_state_transitions
        WHERE requisition_id = ${RO2_REQ} AND to_status = 'draft'
      )
    `;

    console.log("RO-02 mid-wizard draft seeded.");
    console.log(`  Requisition id: ${RO2_REQ} (draft, JD + weighted skills, NOT submitted)`);
    console.log(`  Resume the wizard: /requisitions/new?rid=${RO2_REQ}&step=3`);
    console.log(`  Login: ${HIRING_MANAGER_EMAIL} / TestPassword123!`);
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
