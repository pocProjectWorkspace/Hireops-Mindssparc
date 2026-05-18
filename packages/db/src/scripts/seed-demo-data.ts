/**
 * Seeds end-to-end demo data covering every screen built in Modules 1–4.
 *
 * Walks the demo flow without needing CRS-01 (apply form), AI-03 (real
 * scoring), or a real email provider:
 *
 *   login as recruiter1 → /triage shows 4 candidates in MomentumFeed +
 *   1 candidate in the SLA-breach Hot Zone → open any drawer → for
 *   Candidate E, an offer is already extended and the script prints the
 *   raw signed-link URL → opening that URL exercises the candidate
 *   /offer/[token] accept flow → the apps/workers Workday simulator
 *   then writes a row visible at /admin/integrations.
 *
 * Supersedes the Module 1b `seed-demo-candidates.ts` (deleted in this
 * PR). One canonical script for the whole lifecycle.
 *
 * IDEMPOTENT. Safe to run repeatedly. Stable UUIDs throughout; INSERT
 * ON CONFLICT DO NOTHING for the static FK chain; the applications +
 * application_state_transitions rows are delete-then-reinsert so
 * stage_entered_at refreshes (so Candidate C stays "30h old" each run).
 * Person + candidate rows persist because their content is stable.
 *
 * Candidate E's offer is delete-then-reinsert with a fresh signed-link
 * token each run — that's the URL we print. Old URLs from prior runs
 * are invalidated because the token_hash on the offer row gets
 * replaced.
 *
 * Run:  pnpm db:seed:demo-data
 *
 * Prerequisite:  pnpm db:seed:test-users  (creates recruiter1 etc.)
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

/**
 * Inline copy of @hireops/notifications' signLink + hashToken.
 *
 * Why duplicate: @hireops/notifications depends on @hireops/db, so
 * importing from it here would create a workspace dependency cycle.
 * The primitive is ~20 lines and the format is fully specified in
 * packages/notifications/src/signed-link.ts — keep these two in sync
 * (token format: `<payloadB64>.<macB64>`, payload =
 * `{ a, s, e, n }` JSON, HMAC-SHA256 of payloadB64 with
 * SIGNED_LINK_SECRET, plain SHA-256 for token_hash).
 */
function signSeedLink(action: string, subjectId: string, expiresAt: Date): string {
  const secret = process.env.SIGNED_LINK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SIGNED_LINK_SECRET missing or < 32 chars; generate via openssl rand -base64 48");
  }
  const payload = {
    a: action,
    s: subjectId,
    e: Math.floor(expiresAt.getTime() / 1000),
    n: randomBytes(16).toString("hex"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const macB64 = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${macB64}`;
}

function hashSeedToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const TENANT_SLUG = "kyndryl-poc";
const RECRUITER_EMAIL = "recruiter1@kyndryl-poc.test";
const PORTAL_BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";

// Stable UUIDs — 'a5' prefix marks these as seed-demo-data fixtures.
// All suffix chars must be hex (0-9 a-f). 'p' / 'r' aren't valid hex.
const DEMO_BU = "00000000-0000-4000-8000-00000000a5b0";
const DEMO_ENVELOPE = "00000000-0000-4000-8000-00000000a5e0";
const DEMO_POSITION = "00000000-0000-4000-8000-00000000a5a0";
const DEMO_JD = "00000000-0000-4000-8000-00000000a5d0";
const DEMO_REQ = "00000000-0000-4000-8000-00000000a5c0";
const DEMO_OFFER = "00000000-0000-4000-8000-00000000a5f0";

// Top-level consts (noUncheckedIndexedAccess defeats array narrowing).
const PERSON_A = "00000000-0000-4000-8000-00000000a501";
const PERSON_B = "00000000-0000-4000-8000-00000000a502";
const PERSON_C = "00000000-0000-4000-8000-00000000a503";
const PERSON_D = "00000000-0000-4000-8000-00000000a504";
const PERSON_E = "00000000-0000-4000-8000-00000000a505";

const CAND_A = "00000000-0000-4000-8000-00000000a511";
const CAND_B = "00000000-0000-4000-8000-00000000a512";
const CAND_C = "00000000-0000-4000-8000-00000000a513";
const CAND_D = "00000000-0000-4000-8000-00000000a514";
const CAND_E = "00000000-0000-4000-8000-00000000a515";

const APP_A = "00000000-0000-4000-8000-00000000a521";
const APP_B = "00000000-0000-4000-8000-00000000a522";
const APP_C = "00000000-0000-4000-8000-00000000a523";
const APP_D = "00000000-0000-4000-8000-00000000a524";
const APP_E = "00000000-0000-4000-8000-00000000a525";

const APP_IDS = [APP_A, APP_B, APP_C, APP_D, APP_E];

const JD_BODY = `# Senior Backend Engineer — GCC Bengaluru

## About the role
You'll join the Global Capability Center's platform group, owning
high-throughput services that back the global customer-facing apps.
The role sits between the India-based engineering org and partner
product squads in the UK / US — you should be comfortable navigating
both engineering depth and cross-time-zone collaboration.

## What you'll do
- Build and operate Java / Spring Boot services on Kubernetes (EKS).
- Own Kafka-based event pipelines for downstream analytics + CRM.
- Pair with product + design on API shape; the squad has no PM, so
  judgement on what to build matters as much as how.
- Mentor mid-level engineers in code review + on-call rotations.

## Must-have
- 5+ years on JVM (Java 17+, Spring Boot 3.x).
- Production PostgreSQL — schema design, query tuning, migrations.
- Kafka or similar (Kinesis, Pulsar) at scale (5k+ events/sec).
- Bachelor's degree in CS or equivalent practical depth.

## Nice-to-have
- AWS (EKS, RDS, MSK) operational experience.
- Prior GCC experience working with global product teams.
- Open-source contributions (linked in CV).

## Logistics
- Bengaluru, hybrid (3 days/week onsite at Embassy GolfLinks).
- L5 (Senior), reporting to the Engineering Manager — Platform.
- Compensation: base + variable + joining bonus; benchmarked to top
  quartile for the role + experience band.
`;

// ─────────────── persons ───────────────
//
// Indian-context names, .test TLD emails, varied phone formats.
const DEMO_PERSONS = [
  {
    id: PERSON_A,
    fullName: "Anika Raghavan",
    email: "anika.raghavan@example.test",
    phone: "+919812345601",
    locationCity: "Bengaluru",
  },
  {
    id: PERSON_B,
    fullName: "Vikram Joshi",
    email: "vikram.joshi@example.test",
    phone: "+919812345602",
    locationCity: "Pune",
  },
  {
    id: PERSON_C,
    fullName: "Sneha Banerjee",
    email: "sneha.banerjee@example.test",
    phone: "+919812345603",
    locationCity: "Hyderabad",
  },
  {
    id: PERSON_D,
    fullName: "Karthik Mahadevan",
    email: "karthik.mahadevan@example.test",
    phone: "+919812345604",
    locationCity: "Chennai",
  },
  {
    id: PERSON_E,
    fullName: "Priya Subramanian",
    email: "priya.subramanian@example.test",
    phone: "+919812345605",
    locationCity: "Bengaluru",
  },
];

// ─────────────── candidates / parsed_skills jsonb ───────────────
//
// Hand-crafted to vary years-of-experience, notice period, skills
// overlap with the JD, education tier, and source. Each carries an
// AI-02-shaped parser output (personal / work_history / education /
// skills / notice_period_days / parse_metadata).
//
// `scored_by: 'simulated'` is the honesty marker — when AI-03 ships,
// real scores get `scored_by: 'anthropic'` or similar.

interface DemoCandidate {
  candidateId: string;
  personId: string;
  source: "career_site" | "referral" | "agency_search" | "job_board" | "talent_pool";
  yearsOfExperience: number;
  parsedSkills: Record<string, unknown>;
}

const DEMO_CANDIDATES: DemoCandidate[] = [
  {
    candidateId: CAND_A,
    personId: PERSON_A,
    source: "referral",
    yearsOfExperience: 8.5,
    parsedSkills: {
      personal: { full_name: "Anika Raghavan", email: "anika.raghavan@example.test" },
      work_history: [
        {
          company: "Zalando India",
          title: "Staff Backend Engineer",
          start_date: "2021-03",
          end_date: null,
          highlights: [
            "Led migration of order-fulfilment service from monolith to event-driven microservices on Kafka + AWS EKS",
            "Mentored 4 mid-level engineers; ran weekly code review forum",
          ],
        },
        {
          company: "Walmart Labs Bengaluru",
          title: "Senior Software Engineer",
          start_date: "2017-06",
          end_date: "2021-02",
          highlights: ["Built supplier-onboarding APIs (Java 11, Spring Boot 2)"],
        },
      ],
      education: [
        { institution: "IIT Bombay", degree: "B.Tech Computer Science", graduated: "2017" },
      ],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS", "Kubernetes", "Terraform"],
      notice_period_days: 30,
      parse_metadata: { confidence_score: 0.94, source: "seed-demo-data" },
    },
  },
  {
    candidateId: CAND_B,
    personId: PERSON_B,
    source: "career_site",
    yearsOfExperience: 4,
    parsedSkills: {
      personal: { full_name: "Vikram Joshi", email: "vikram.joshi@example.test" },
      work_history: [
        {
          company: "Persistent Systems",
          title: "Software Engineer",
          start_date: "2020-08",
          end_date: null,
          highlights: ["Java + Spring Boot REST APIs for a US insurance client"],
        },
      ],
      education: [
        { institution: "COEP Pune", degree: "B.Tech Computer Science", graduated: "2020" },
      ],
      // Notice the lack of Kafka — that's why the AI score is mid.
      skills: ["Java", "Spring Boot", "PostgreSQL", "REST APIs", "JUnit"],
      notice_period_days: 60,
      parse_metadata: { confidence_score: 0.91, source: "seed-demo-data" },
    },
  },
  {
    candidateId: CAND_C,
    personId: PERSON_C,
    source: "agency_search",
    yearsOfExperience: 10,
    parsedSkills: {
      personal: { full_name: "Sneha Banerjee", email: "sneha.banerjee@example.test" },
      work_history: [
        {
          company: "Microsoft IDC",
          title: "Principal Engineer",
          start_date: "2019-01",
          end_date: null,
          highlights: [
            "Architected M365 telemetry pipeline (Kafka → ADX) handling 50k events/sec",
            "Drove platform-wide Java 17 upgrade across 18 services",
          ],
        },
        {
          company: "Goldman Sachs",
          title: "Senior Software Engineer",
          start_date: "2015-07",
          end_date: "2018-12",
          highlights: ["Trade-capture services on PostgreSQL + Kafka"],
        },
      ],
      education: [
        {
          institution: "BITS Pilani",
          degree: "M.S. Software Systems",
          graduated: "2015",
        },
      ],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "Azure", "Kubernetes"],
      // 90-day notice — the candidate is strong but slow to start.
      notice_period_days: 90,
      parse_metadata: { confidence_score: 0.96, source: "seed-demo-data" },
    },
  },
  {
    candidateId: CAND_D,
    personId: PERSON_D,
    source: "job_board",
    yearsOfExperience: 6,
    parsedSkills: {
      personal: { full_name: "Karthik Mahadevan", email: "karthik.mahadevan@example.test" },
      work_history: [
        {
          company: "Freshworks",
          title: "Senior Software Engineer",
          start_date: "2020-04",
          end_date: null,
          highlights: ["Customer-support backend on Ruby + Java; led migration to event-driven model"],
        },
      ],
      education: [
        { institution: "Anna University", degree: "B.E. CSE", graduated: "2018" },
      ],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "Redis", "AWS"],
      notice_period_days: 45,
      parse_metadata: { confidence_score: 0.93, source: "seed-demo-data" },
    },
  },
  {
    candidateId: CAND_E,
    personId: PERSON_E,
    source: "referral",
    yearsOfExperience: 7,
    parsedSkills: {
      personal: { full_name: "Priya Subramanian", email: "priya.subramanian@example.test" },
      work_history: [
        {
          company: "Razorpay",
          title: "Senior Backend Engineer",
          start_date: "2021-07",
          end_date: null,
          highlights: [
            "Owns payments-recon service; Kafka consumers + PostgreSQL writes at 12k tx/sec",
            "Designed idempotency layer that became platform standard",
          ],
        },
        {
          company: "Flipkart",
          title: "Software Engineer II",
          start_date: "2018-08",
          end_date: "2021-06",
          highlights: ["Order-management APIs on Spring Boot + Cassandra"],
        },
      ],
      education: [
        { institution: "NIT Trichy", degree: "B.Tech CSE", graduated: "2018" },
      ],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS", "Cassandra"],
      notice_period_days: 60,
      parse_metadata: { confidence_score: 0.95, source: "seed-demo-data" },
    },
  },
];

interface DemoApp {
  appId: string;
  candidateId: string;
  stage: string;
  createdAtInterval: string; // SQL interval expression, e.g. "2 hours"
  stageEnteredAtInterval: string;
  aiScore: number;
  aiScoreExplanation: Record<string, unknown>;
  source: DemoCandidate["source"];
  // Each entry: [from_stage or null, to_stage, transitioned_at SQL interval].
  transitions: { from: string | null; to: string; ageInterval: string; reason?: string }[];
}

const DEMO_APPS: DemoApp[] = [
  // A — high-score, fresh → top of MomentumFeed
  {
    appId: APP_A,
    candidateId: CAND_A,
    stage: "application_received",
    createdAtInterval: "2 hours",
    stageEnteredAtInterval: "2 hours",
    aiScore: 92,
    aiScoreExplanation: {
      top_factors: [
        { factor: "skills_match", score: 0.94, note: "5/5 required skills matched (Java, Spring Boot, Kafka, PostgreSQL, AWS)" },
        { factor: "experience_level", score: 0.92, note: "8.5 years matches L5 target band" },
        { factor: "notice_period", score: 0.88, note: "30-day notice — acceptable" },
        { factor: "education_signal", score: 0.85, note: "IIT Bombay B.Tech" },
      ],
      caveats: [],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "referral",
    transitions: [{ from: null, to: "application_received", ageInterval: "2 hours" }],
  },
  // B — mid-score, fresh → middle of MomentumFeed
  {
    appId: APP_B,
    candidateId: CAND_B,
    stage: "application_received",
    createdAtInterval: "6 hours",
    stageEnteredAtInterval: "6 hours",
    aiScore: 64,
    aiScoreExplanation: {
      top_factors: [
        { factor: "skills_match", score: 0.62, note: "3/5 required skills matched; missing Kafka and AWS depth" },
        { factor: "experience_level", score: 0.68, note: "4 years — below L5 floor of 5 years" },
        { factor: "notice_period", score: 0.55, note: "60-day notice — slow start" },
      ],
      caveats: ["Experience level slightly under L5 expectation"],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "career_site",
    transitions: [{ from: null, to: "application_received", ageInterval: "6 hours" }],
  },
  // C — high-score but 30h old → Hot Zone (SLA breach for application_received = 24h)
  {
    appId: APP_C,
    candidateId: CAND_C,
    stage: "application_received",
    createdAtInterval: "30 hours",
    stageEnteredAtInterval: "30 hours",
    aiScore: 88,
    aiScoreExplanation: {
      top_factors: [
        { factor: "skills_match", score: 0.90, note: "All required skills + Azure depth" },
        { factor: "experience_level", score: 0.95, note: "10 years — strong fit for L5 senior band" },
        { factor: "education_signal", score: 0.92, note: "M.S. from BITS Pilani" },
        { factor: "notice_period", score: 0.40, note: "90-day notice — long lead time" },
      ],
      caveats: ["Notice period of 90 days exceeds typical preference"],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "agency_search",
    transitions: [{ from: null, to: "application_received", ageInterval: "30 hours" }],
  },
  // D — mid-pipeline, recruiter_review (drawer demo).
  {
    appId: APP_D,
    candidateId: CAND_D,
    stage: "recruiter_review",
    createdAtInterval: "5 days",
    stageEnteredAtInterval: "2 days",
    aiScore: 81,
    aiScoreExplanation: {
      top_factors: [
        { factor: "skills_match", score: 0.84, note: "4/5 required skills; AWS in past role only" },
        { factor: "experience_level", score: 0.82, note: "6 years — comfortable at L5 with growth runway" },
        { factor: "notice_period", score: 0.75, note: "45-day notice" },
      ],
      caveats: [],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "job_board",
    transitions: [
      { from: null, to: "application_received", ageInterval: "5 days" },
      {
        from: "application_received",
        to: "recruiter_review",
        ageInterval: "2 days",
        reason: "Recruiter shortlisted based on AI score + skill overlap",
      },
    ],
  },
  // E — offer extended (offer_drafted is the enum value the application
  // sits at while an offer is outstanding; the offer row itself is
  // status='extended').
  {
    appId: APP_E,
    candidateId: CAND_E,
    stage: "offer_drafted",
    createdAtInterval: "10 days",
    stageEnteredAtInterval: "1 hour",
    aiScore: 85,
    aiScoreExplanation: {
      top_factors: [
        { factor: "skills_match", score: 0.88, note: "All required skills + payments-domain depth" },
        { factor: "experience_level", score: 0.85, note: "7 years — solid L5" },
        { factor: "interview_signal", score: 0.90, note: "Strong rubric scores in tech + HR rounds" },
      ],
      caveats: [],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "referral",
    transitions: [
      { from: null, to: "application_received", ageInterval: "10 days" },
      {
        from: "application_received",
        to: "recruiter_review",
        ageInterval: "9 days",
        reason: "Recruiter shortlisted",
      },
      {
        from: "recruiter_review",
        to: "tech_interview",
        ageInterval: "7 days",
        reason: "Passed phone screen; scheduled for technical round",
      },
      {
        from: "tech_interview",
        to: "hr_round",
        ageInterval: "4 days",
        reason: "Tech round passed; sent to HR for compensation discussion",
      },
      {
        from: "hr_round",
        to: "offer_drafted",
        ageInterval: "1 hour",
        reason: "Offer extended via signed link (seed-demo-data)",
      },
    ],
  },
];

// Offer E — base ₹38L, variable ₹6L, joining bonus ₹1.5L, 7-day expiry.
const OFFER_E = {
  baseSalaryInrPaise: BigInt(3_800_000) * 100n, // ₹38L
  variableTargetInrPaise: BigInt(600_000) * 100n, // ₹6L
  joiningBonusInrPaise: BigInt(150_000) * 100n, // ₹1.5L
  location: "Bengaluru (Hybrid)",
  termsHtml:
    "Standard at-will employment under Karnataka Shops & Commercial Establishments Act, 1961. " +
    "Notice period 60 days post-confirmation. Joining bonus clawback if separated within 12 months. " +
    "Detailed terms in the attached offer letter.",
  expiryDays: 7,
};

async function main() {
  // Dynamic imports so dotenv (above) runs before client.ts evaluates
  // DATABASE_URL at module init. Same pattern as seed-test-users.ts.
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
  console.log(`Seeding demo data into tenant ${TENANT_SLUG} (${tid})`);

  // Look up recruiter1's membership specifically — the script assigns
  // all reqs to them so a single login covers every demo screen.
  const [recruiter] = await poolSql<{ id: string }[]>`
    SELECT tum.id
    FROM public.tenant_user_memberships tum
    JOIN auth.users au ON au.id = tum.user_id
    WHERE tum.tenant_id = ${tid}
      AND tum.status = 'active'
      AND au.email = ${RECRUITER_EMAIL}
    LIMIT 1
  `;
  if (!recruiter) {
    console.error(
      `recruiter ${RECRUITER_EMAIL} not found in ${TENANT_SLUG}. Run pnpm db:seed:test-users first.`,
    );
    process.exit(2);
  }
  const recruiterId = recruiter.id;

  // ── 1. BU / envelope / position / JD / req / req_recruiter ──────
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${DEMO_BU}, ${tid}, 'Global Capability Center - Bengaluru', 'gcc-blr')
    ON CONFLICT (id) DO NOTHING
  `;
  // Envelope: current FY 2026 (April-aligned per Indian fiscal year),
  // 8 planned heads, status approved so the requisition can link.
  await poolSql`
    INSERT INTO public.headcount_envelopes
      (id, tenant_id, business_unit_id, period_start, period_end,
       planned_headcount, status, notes)
    VALUES (${DEMO_ENVELOPE}, ${tid}, ${DEMO_BU},
            '2026-04-01', '2027-03-31',
            8, 'approved', 'Demo envelope — seed-demo-data')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type,
       primary_location, is_active)
    VALUES (${DEMO_POSITION}, ${tid}, ${DEMO_BU},
            'Senior Backend Engineer', 'hybrid',
            'Bengaluru', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${DEMO_JD}, ${tid}, ${DEMO_POSITION}, 1, ${JD_BODY}, 'approved')
    ON CONFLICT (id) DO NOTHING
  `;

  // JD skills — derived from the JD body's must-have list.
  const REQUIRED_SKILLS = ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS"] as const;
  for (const skill of REQUIRED_SKILLS) {
    await poolSql`
      INSERT INTO public.jd_skills
        (tenant_id, jd_version_id, skill_name, weight, is_required)
      VALUES (${tid}, ${DEMO_JD}, ${skill}, 1.00, true)
      ON CONFLICT DO NOTHING
    `;
  }

  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
       primary_recruiter_id, hiring_manager_id, status, number_of_openings,
       target_start_date, is_public, public_slug, posted_at)
    VALUES (${DEMO_REQ}, ${tid}, ${DEMO_POSITION}, ${DEMO_JD}, ${DEMO_ENVELOPE},
            ${recruiterId}, ${recruiterId}, 'posted', 1,
            (now() + interval '30 days')::date,
            true, 'gcc-blr-senior-backend',
            now() - interval '11 days')
    ON CONFLICT (id) DO NOTHING
  `;
  // requisition_recruiters assignment (sparse junction; we still add the
  // row so the screen reflects the assignment shape correctly).
  await poolSql`
    INSERT INTO public.requisition_recruiters
      (tenant_id, requisition_id, recruiter_id)
    VALUES (${tid}, ${DEMO_REQ}, ${recruiterId})
    ON CONFLICT DO NOTHING
  `;

  // ── 2. persons + candidates ─────────────────────────────────────
  for (const p of DEMO_PERSONS) {
    await poolSql`
      INSERT INTO public.persons
        (id, tenant_id, full_name, email_primary, email_normalised,
         phone_primary, phone_normalised, location_country)
      VALUES (${p.id}, ${tid}, ${p.fullName}, ${p.email}, ${p.email.toLowerCase()},
              ${p.phone}, ${p.phone.replace(/[^0-9]/g, "")}, 'IN')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const c of DEMO_CANDIDATES) {
    await poolSql`
      INSERT INTO public.candidates
        (id, tenant_id, person_id, source, consent_version,
         years_of_experience, parsed_skills)
      VALUES (${c.candidateId}, ${tid}, ${c.personId}, ${c.source}, 'v1',
              ${c.yearsOfExperience.toFixed(1)},
              ${JSON.stringify(c.parsedSkills)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // ── 3. applications + state transitions ─────────────────────────
  //
  // Delete then re-insert so created_at / stage_entered_at refresh
  // (Candidate C needs to be "30h old" on every run).
  for (const id of APP_IDS) {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${id}`;
  }
  // Clear any prior offer for E before re-inserting the app (FK
  // applications → offers cascade is "restrict" because offers reference
  // applications, not the other way; we just delete the offer row).
  await poolSql`DELETE FROM public.workday_sync_outbox WHERE subject_application_id = ${APP_E}`;
  await poolSql`DELETE FROM public.offers WHERE id = ${DEMO_OFFER}`;
  for (const id of APP_IDS) {
    await poolSql`DELETE FROM public.applications WHERE id = ${id}`;
  }

  for (const a of DEMO_APPS) {
    // Application row. Use poolSql.unsafe so we can inline SQL intervals
    // (`now() - interval '2 hours'`) — these can't be bound as params.
    await poolSql.unsafe(`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source,
         current_stage, stage_entered_at, ai_score, ai_score_explanation,
         created_at, updated_at)
      VALUES ('${a.appId}', '${tid}', '${a.candidateId}', '${DEMO_REQ}',
              '${a.source}',
              '${a.stage}',
              now() - interval '${a.stageEnteredAtInterval}',
              ${a.aiScore},
              '${JSON.stringify(a.aiScoreExplanation)}'::jsonb,
              now() - interval '${a.createdAtInterval}',
              now() - interval '${a.stageEnteredAtInterval}')
    `);

    // State transitions. fromStage NULL → first entry; otherwise the
    // forward step. ageInterval = how long ago the transition happened.
    for (const t of a.transitions) {
      const fromSql = t.from === null ? "NULL" : `'${t.from}'`;
      const reasonSql = t.reason ? `'${t.reason.replace(/'/g, "''")}'` : "NULL";
      await poolSql.unsafe(`
        INSERT INTO public.application_state_transitions
          (tenant_id, application_id, from_stage, to_stage,
           transitioned_at, reason, actor_membership_id)
        VALUES ('${tid}', '${a.appId}', ${fromSql}, '${t.to}',
                now() - interval '${t.ageInterval}',
                ${reasonSql},
                '${recruiterId}')
      `);
    }
  }

  // ── 4. Candidate E's extended offer + signed-link token ─────────
  //
  // 7-day window from now. signLink replicates exactly what the
  // extendOffer mutation does in production — same secret, same
  // (action, subjectId, expiresAt, nonce) payload, same SHA-256
  // token_hash.
  const expiresAt = new Date(Date.now() + OFFER_E.expiryDays * 24 * 60 * 60 * 1000);
  const token = signSeedLink("candidate.accept_offer", DEMO_OFFER, expiresAt);
  const tokenHash = hashSeedToken(token);
  const joiningDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // postgres-js rejects bigint params; stringify the paise values + cast
  // to bigint server-side. expires_at goes via ISO string for the same
  // safety as the other scripts (postgres-js Date-binding is fine but
  // varies by parser config).
  await poolSql`
    INSERT INTO public.offers
      (id, tenant_id, application_id, drafted_by_membership_id,
       base_salary_inr_paise, variable_target_inr_paise, joining_bonus_inr_paise,
       joining_date, location, expiry_at, terms_html,
       status, extended_at, accept_signed_link_token_hash,
       created_at, updated_at)
    VALUES (${DEMO_OFFER}, ${tid}, ${APP_E}, ${recruiterId},
            ${OFFER_E.baseSalaryInrPaise.toString()}::bigint,
            ${OFFER_E.variableTargetInrPaise.toString()}::bigint,
            ${OFFER_E.joiningBonusInrPaise.toString()}::bigint,
            ${joiningDate}, ${OFFER_E.location},
            ${expiresAt.toISOString()}, ${OFFER_E.termsHtml},
            'extended', now() - interval '1 hour', ${tokenHash},
            now() - interval '1 hour', now() - interval '1 hour')
  `;

  // ── 5. summary ──────────────────────────────────────────────────
  const acceptUrl = `${PORTAL_BASE}/offer/${token}`;
  console.log("");
  console.log(`Seeded ${DEMO_APPS.length} applications under requisition ${DEMO_REQ}`);
  console.log("  A. Anika Raghavan      application_received   score=92   2h ago   (MomentumFeed top)");
  console.log("  B. Vikram Joshi        application_received   score=64   6h ago   (MomentumFeed mid)");
  console.log("  C. Sneha Banerjee      application_received   score=88   30h ago  (Hot Zone — SLA breach)");
  console.log("  D. Karthik Mahadevan   recruiter_review       score=81   2d in stage  (drawer demo)");
  console.log("  E. Priya Subramanian   offer_drafted          score=85   offer extended 1h ago");
  console.log("");
  console.log("Candidate E offer-accept URL (single-use, expires in 7 days):");
  console.log(`  ${acceptUrl}`);
  console.log("");
  console.log("Public apply URL (CRS-01, anyone can submit):");
  console.log(`  ${PORTAL_BASE}/t/${TENANT_SLUG}/apply/gcc-blr-senior-backend`);
  console.log("");
  console.log("Login as recruiter1@kyndryl-poc.test / TestPassword123! to walk the lifecycle.");
}

main()
  .then(() => {
    // postgres-js keeps idle connections open until end() is called;
    // without an explicit exit Node sits waiting indefinitely.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
