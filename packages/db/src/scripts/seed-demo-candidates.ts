/**
 * Seeds 3 demo applications in the kyndryl-poc tenant so the internal
 * portal has something to render on /triage. Used by:
 *   - the Module 1b Playwright E2E (drawer-open flow)
 *   - manual demo-day rehearsal
 *
 * Idempotent: uses fixed UUIDs for the three demo applications,
 * onConflictDoNothing on every insert, plus a clean-then-reseed for
 * the application rows so stage_entered_at refreshes (the SLA breach
 * row needs to be "old" each time we run).
 *
 * Three personas:
 *   1. Maya Singh — recent application_received, high AI score (88) → MomentumFeed top
 *   2. Rohan Iyer — application_received from 48h ago → HotZone (SLA breach @ 24h)
 *   3. Alex Park  — fresh application_received, mid AI score (62) → MomentumFeed mid
 *
 * Run: pnpm db:seed:demo-candidates
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

// Stable UUIDs so re-runs upsert cleanly.
const TENANT_SLUG = "kyndryl-poc";

const DEMO_BU = "00000000-0000-4000-8000-00000ade00b1";
const DEMO_POSITION = "00000000-0000-4000-8000-00000ade00b2";
const DEMO_JD = "00000000-0000-4000-8000-00000ade00b3";
const DEMO_REQ = "00000000-0000-4000-8000-00000ade00b4";

// IDs hoisted to top-level consts so index-access narrowing (which
// `noUncheckedIndexedAccess` defeats) isn't needed downstream.
const PERSON_MAYA = "00000000-0000-4000-8000-00000ade01a1";
const PERSON_ROHAN = "00000000-0000-4000-8000-00000ade01a2";
const PERSON_ALEX = "00000000-0000-4000-8000-00000ade01a3";

const CAND_MAYA = "00000000-0000-4000-8000-00000ade02a1";
const CAND_ROHAN = "00000000-0000-4000-8000-00000ade02a2";
const CAND_ALEX = "00000000-0000-4000-8000-00000ade02a3";

const APP_MAYA = "00000000-0000-4000-8000-00000ade03a1";
const APP_ROHAN = "00000000-0000-4000-8000-00000ade03a2";
const APP_ALEX = "00000000-0000-4000-8000-00000ade03a3";

const DEMO_PERSONS = [
  { id: PERSON_MAYA, fullName: "Maya Singh", email: "maya.singh@example.com" },
  { id: PERSON_ROHAN, fullName: "Rohan Iyer", email: "rohan.iyer@example.com" },
  { id: PERSON_ALEX, fullName: "Alex Park", email: "alex.park@example.com" },
];

const DEMO_CANDIDATES = [
  { id: CAND_MAYA, personId: PERSON_MAYA },
  { id: CAND_ROHAN, personId: PERSON_ROHAN },
  { id: CAND_ALEX, personId: PERSON_ALEX },
];

const DEMO_APPS = [
  // Fresh, high-score → MomentumFeed top.
  {
    id: APP_MAYA,
    candidateId: CAND_MAYA,
    stage: "application_received" as const,
    stageEnteredAtSqlExpr: "now()",
    aiScore: 88,
    aiScoreExplanation: {
      top_factors: [
        { label: "Python", weight: 0.32, description: "8 years matching the JD" },
        { label: "AWS", weight: 0.18 },
        { label: "Lead experience", weight: 0.12 },
      ],
      model: "claude-sonnet-4-6",
    },
  },
  // 48h-old → SLA breach (Hot Zone).
  {
    id: APP_ROHAN,
    candidateId: CAND_ROHAN,
    stage: "application_received" as const,
    stageEnteredAtSqlExpr: "now() - interval '48 hours'",
    aiScore: 71,
    aiScoreExplanation: {
      top_factors: [
        { label: "Java", weight: 0.21 },
        { label: "Kafka", weight: 0.15 },
      ],
    },
  },
  // Fresh, mid-score → MomentumFeed mid.
  {
    id: APP_ALEX,
    candidateId: CAND_ALEX,
    stage: "application_received" as const,
    stageEnteredAtSqlExpr: "now()",
    aiScore: 62,
    aiScoreExplanation: { top_factors: [{ label: "TypeScript", weight: 0.18 }] },
  },
];

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, sql: poolSql } = await import("../client");
  const { tenants } = await import("../schema");

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, TENANT_SLUG))
    .limit(1);
  if (!tenant) {
    console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
    process.exit(2);
  }
  const tid = tenant.id;
  console.log(`Seeding demo candidates into tenant ${TENANT_SLUG} (${tid})`);

  // Reqs / position / JD / BU. ON CONFLICT DO NOTHING.
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${DEMO_BU}, ${tid}, 'Demo Engineering', 'demo-eng')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${DEMO_POSITION}, ${tid}, ${DEMO_BU}, 'Senior Software Engineer', 'remote', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${DEMO_JD}, ${tid}, ${DEMO_POSITION}, 1, '# Senior SWE', 'approved')
    ON CONFLICT (id) DO NOTHING
  `;
  // Pick a recruiter membership from the tenant (first active admin/recruiter).
  const [recruiter] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships
    WHERE tenant_id = ${tid} AND status = 'active'
    ORDER BY created_at LIMIT 1
  `;
  if (!recruiter) {
    console.error("No active membership in kyndryl-poc — run db:seed:test-users first.");
    process.exit(2);
  }
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public)
    VALUES (${DEMO_REQ}, ${tid}, ${DEMO_POSITION}, ${DEMO_JD}, ${recruiter.id}, ${recruiter.id}, 'posted', true)
    ON CONFLICT (id) DO NOTHING
  `;

  // Persons + candidates: idempotent.
  for (const p of DEMO_PERSONS) {
    await poolSql`
      INSERT INTO public.persons
        (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${p.id}, ${tid}, ${p.fullName}, ${p.email}, ${p.email.toLowerCase()})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const c of DEMO_CANDIDATES) {
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${c.id}, ${tid}, ${c.personId}, 'career_site', 'v1')
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // Applications: delete then re-insert so stage_entered_at refreshes
  // (the SLA breach row depends on the timestamp being "old" each run).
  for (const a of DEMO_APPS) {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${a.id}`;
    await poolSql`DELETE FROM public.applications WHERE id = ${a.id}`;
  }
  for (const a of DEMO_APPS) {
    await poolSql.unsafe(`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at, ai_score, ai_score_explanation)
      VALUES ('${a.id}', '${tid}', '${a.candidateId}', '${DEMO_REQ}', 'career_site', '${a.stage}', ${a.stageEnteredAtSqlExpr}, ${a.aiScore}, '${JSON.stringify(a.aiScoreExplanation)}'::jsonb)
    `);
  }

  console.log(`Seeded ${DEMO_APPS.length} demo applications under requisition ${DEMO_REQ}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
