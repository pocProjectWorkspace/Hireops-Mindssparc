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
    throw new Error(
      "SIGNED_LINK_SECRET missing or < 32 chars; generate via openssl rand -base64 48",
    );
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
// PERSON_F — AI-03 real-scoring path. Distinct from A-E (those carry
// `scored_by: "simulated"` as the honesty marker for demo scoring).
// Candidate F lands as a pending ai_score_outbox row; the apps/workers
// loop drains it via getAIClient(tenantId) → real Anthropic call when
// ANTHROPIC_API_KEY is present (LocalAIClient fixture otherwise).
const PERSON_F = "00000000-0000-4000-8000-00000000a506";
// SEED-01 — G/H are the follow-ups wedge candidates, both stuck at
// tech_interview past the 5-day threshold. G carries a pre-seeded
// pending approval; H is the scanner's live-fire target (no seeded run).
const PERSON_G = "00000000-0000-4000-8000-00000000a507";
const PERSON_H = "00000000-0000-4000-8000-00000000a508";

const CAND_A = "00000000-0000-4000-8000-00000000a511";
const CAND_B = "00000000-0000-4000-8000-00000000a512";
const CAND_C = "00000000-0000-4000-8000-00000000a513";
const CAND_D = "00000000-0000-4000-8000-00000000a514";
const CAND_E = "00000000-0000-4000-8000-00000000a515";
const CAND_F = "00000000-0000-4000-8000-00000000a516";
const CAND_G = "00000000-0000-4000-8000-00000000a517";
const CAND_H = "00000000-0000-4000-8000-00000000a518";

const APP_A = "00000000-0000-4000-8000-00000000a521";
const APP_B = "00000000-0000-4000-8000-00000000a522";
const APP_C = "00000000-0000-4000-8000-00000000a523";
const APP_D = "00000000-0000-4000-8000-00000000a524";
const APP_E = "00000000-0000-4000-8000-00000000a525";
const APP_F = "00000000-0000-4000-8000-00000000a526";
const APP_G = "00000000-0000-4000-8000-00000000a527";
const APP_H = "00000000-0000-4000-8000-00000000a528";

const APP_IDS = [APP_A, APP_B, APP_C, APP_D, APP_E, APP_F, APP_G, APP_H];

// ─────────────── SEED-01 follow-ups agent + paused-run ids ───────────────
//
// Deterministic ids for the "Demo Follow-ups Agent" and the believable
// pending approval seeded for Candidate G. All hex-suffixed 'a59x' — a
// namespace unused by the a5a0-a5f0 static chain above.
const DEMO_AGENT = "00000000-0000-4000-8000-00000000a590";
const DEMO_AGENT_TRIGGER = "00000000-0000-4000-8000-00000000a591";
const DEMO_DRAFT_ACTION = "00000000-0000-4000-8000-00000000a592";
const DEMO_SEND_ACTION = "00000000-0000-4000-8000-00000000a593";
const DEMO_DRAFT_RULE = "00000000-0000-4000-8000-00000000a594";
const DEMO_SEND_RULE = "00000000-0000-4000-8000-00000000a595";
const DEMO_RUN_G = "00000000-0000-4000-8000-00000000a596";
const DEMO_RUN_ACTION_G = "00000000-0000-4000-8000-00000000a597";
const DEMO_OUTBOX_G = "00000000-0000-4000-8000-00000000a598";
const DEMO_APPROVAL_G = "00000000-0000-4000-8000-00000000a599";

// ─────────────── ONBOARD-04 onboarding demo namespace ───────────────
//
// Six onboarding cases so a fresh seed makes /onboarding look ALIVE. Their
// own hex-suffixed a5xx blocks (a53x persons, a54x candidates, a55x
// applications, a56x cases, a57x accepted offers) — distinct from the
// recruitment chain (a5[0-2]x) and the agent chain (a59x). a5xx = protected
// from the groom, so these seeded cases are never classed as residue.
const ONB_HR_OPS_EMAIL = "hr_ops1@kyndryl-poc.test";
const ONB_ADMIN_EMAIL = "admin1@kyndryl-poc.test";

const ONB_PERSON_IDS = [
  "00000000-0000-4000-8000-00000000a531",
  "00000000-0000-4000-8000-00000000a532",
  "00000000-0000-4000-8000-00000000a533",
  "00000000-0000-4000-8000-00000000a534",
  "00000000-0000-4000-8000-00000000a535",
  "00000000-0000-4000-8000-00000000a536",
] as const;
const ONB_CANDIDATE_IDS = [
  "00000000-0000-4000-8000-00000000a541",
  "00000000-0000-4000-8000-00000000a542",
  "00000000-0000-4000-8000-00000000a543",
  "00000000-0000-4000-8000-00000000a544",
  "00000000-0000-4000-8000-00000000a545",
  "00000000-0000-4000-8000-00000000a546",
] as const;
const ONB_APP_IDS = [
  "00000000-0000-4000-8000-00000000a551",
  "00000000-0000-4000-8000-00000000a552",
  "00000000-0000-4000-8000-00000000a553",
  "00000000-0000-4000-8000-00000000a554",
  "00000000-0000-4000-8000-00000000a555",
  "00000000-0000-4000-8000-00000000a556",
] as const;
const ONB_CASE_IDS = [
  "00000000-0000-4000-8000-00000000a561",
  "00000000-0000-4000-8000-00000000a562",
  "00000000-0000-4000-8000-00000000a563",
  "00000000-0000-4000-8000-00000000a564",
  "00000000-0000-4000-8000-00000000a565",
  "00000000-0000-4000-8000-00000000a566",
] as const;
const ONB_OFFER_IDS = [
  "00000000-0000-4000-8000-00000000a571",
  "00000000-0000-4000-8000-00000000a572",
  "00000000-0000-4000-8000-00000000a573",
  "00000000-0000-4000-8000-00000000a574",
  "00000000-0000-4000-8000-00000000a575",
  "00000000-0000-4000-8000-00000000a576",
] as const;

const DEMO_AGENT_NAME = "Demo Follow-ups Agent";
const STALE_STAGE = "tech_interview";
const STALE_DAYS_THRESHOLD = 5;
const FOLLOWUP_TONE = "friendly";
const FOLLOWUP_MAX_TOKENS = 300;

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
  {
    id: PERSON_F,
    fullName: "Aarav Iyer",
    email: "aarav.iyer@example.test",
    phone: "+919812345606",
    locationCity: "Bengaluru",
  },
  {
    id: PERSON_G,
    fullName: "Rohan Desai",
    email: "digitalfuturity@outlook.com",
    phone: "+919812345607",
    locationCity: "Bengaluru",
  },
  {
    id: PERSON_H,
    fullName: "Meera Nair",
    email: "meera.nair@example.test",
    phone: "+919812345608",
    locationCity: "Kochi",
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
          highlights: [
            "Customer-support backend on Ruby + Java; led migration to event-driven model",
          ],
        },
      ],
      education: [{ institution: "Anna University", degree: "B.E. CSE", graduated: "2018" }],
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
      education: [{ institution: "NIT Trichy", degree: "B.Tech CSE", graduated: "2018" }],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS", "Cassandra"],
      notice_period_days: 60,
      parse_metadata: { confidence_score: 0.95, source: "seed-demo-data" },
    },
  },
  // F — AI-03 real-scoring path. The parsedSkills below conforms to
  // the strict ParserOutput shape from
  // packages/ai-client/src/parsers/resume-schema.ts (every field A-E
  // omit because their scores are pre-seeded with scored_by:
  // "simulated"). The worker's loadContext zod-parses parsed_skills
  // against parserOutputSchema, so anything outside that shape would
  // fail terminally; F MUST conform.
  {
    candidateId: CAND_F,
    personId: PERSON_F,
    source: "career_site",
    yearsOfExperience: 6,
    parsedSkills: {
      personal: {
        full_name: "Aarav Iyer",
        email: "aarav.iyer@example.test",
        phone: "+919812345606",
        location_city: "Bengaluru",
        location_country: "IN",
        linkedin_url: null,
        github_url: null,
        portfolio_url: null,
      },
      summary:
        "Backend engineer with six years of experience in high-throughput Java services on AWS and Kafka.",
      total_years_experience: 6,
      current_role: {
        title: "Senior Backend Engineer",
        company: "Swiggy",
        start_date: "2022-03",
        location: "Bengaluru",
        description:
          "Owns merchant-payouts pipeline; Kafka + Postgres at 8k tx/sec; on-call rotation lead.",
      },
      work_history: [
        {
          title: "Senior Backend Engineer",
          company: "Swiggy",
          start_date: "2022-03",
          end_date: null,
          location: "Bengaluru",
          description:
            "Owns merchant-payouts pipeline; Kafka + Postgres at 8k tx/sec; on-call rotation lead.",
          employment_type: "full_time",
        },
        {
          title: "Software Engineer II",
          company: "Myntra",
          start_date: "2019-07",
          end_date: "2022-02",
          location: "Bengaluru",
          description: "Order-orchestration service on Spring Boot + Kafka + PostgreSQL.",
          employment_type: "full_time",
        },
      ],
      education: [
        {
          degree: "B.Tech",
          field_of_study: "Computer Science",
          institution: "IIIT Hyderabad",
          start_year: 2015,
          end_year: 2019,
          grade: "8.6 CGPA",
        },
      ],
      skills: {
        technical: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS", "Redis", "Kubernetes"],
        languages: ["English", "Hindi", "Tamil"],
        certifications: [],
        domain: ["payments", "e-commerce"],
      },
      notice_period_days: 60,
      expected_compensation: null,
      parse_metadata: {
        parser_version: "1.0.0",
        parsed_at: new Date().toISOString(),
        confidence_score: 0.92,
        source_format: "pdf_text",
        parser_model: "claude-sonnet-4-6",
      },
    },
  },
  // G — SEED-01 follow-ups wedge: strong candidate stuck at tech_interview
  // for ~7 days. Carries the pre-seeded pending approval.
  {
    candidateId: CAND_G,
    personId: PERSON_G,
    source: "referral",
    yearsOfExperience: 7,
    parsedSkills: {
      personal: { full_name: "Rohan Desai", email: "digitalfuturity@outlook.com" },
      work_history: [
        {
          company: "PhonePe",
          title: "Senior Backend Engineer",
          start_date: "2021-05",
          end_date: null,
          highlights: [
            "Owns UPI settlement reconciliation; Kafka consumers + PostgreSQL at 15k tx/sec",
            "Cut p99 latency 40% by re-sharding the ledger service",
          ],
        },
        {
          company: "Zeta",
          title: "Software Engineer II",
          start_date: "2018-06",
          end_date: "2021-04",
          highlights: ["Card-issuance APIs on Spring Boot + PostgreSQL"],
        },
      ],
      education: [{ institution: "VIT Vellore", degree: "B.Tech CSE", graduated: "2018" }],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS", "Redis"],
      notice_period_days: 30,
      parse_metadata: { confidence_score: 0.95, source: "seed-demo-data" },
    },
  },
  // H — SEED-01 follow-ups wedge: second stale candidate at tech_interview
  // (~6 days). No seeded run — the stage_stale scanner live-fires on H.
  {
    candidateId: CAND_H,
    personId: PERSON_H,
    source: "job_board",
    yearsOfExperience: 6,
    parsedSkills: {
      personal: { full_name: "Meera Nair", email: "meera.nair@example.test" },
      work_history: [
        {
          company: "Nutanix India",
          title: "Senior Software Engineer",
          start_date: "2020-09",
          end_date: null,
          highlights: ["Distributed storage control-plane services in Java + Kafka"],
        },
      ],
      education: [{ institution: "NIT Calicut", degree: "B.Tech CSE", graduated: "2017" }],
      skills: ["Java", "Spring Boot", "Kafka", "PostgreSQL", "AWS"],
      notice_period_days: 45,
      parse_metadata: { confidence_score: 0.93, source: "seed-demo-data" },
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
        {
          factor: "skills_match",
          score: 0.94,
          note: "5/5 required skills matched (Java, Spring Boot, Kafka, PostgreSQL, AWS)",
        },
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
        {
          factor: "skills_match",
          score: 0.62,
          note: "3/5 required skills matched; missing Kafka and AWS depth",
        },
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
        { factor: "skills_match", score: 0.9, note: "All required skills + Azure depth" },
        {
          factor: "experience_level",
          score: 0.95,
          note: "10 years — strong fit for L5 senior band",
        },
        { factor: "education_signal", score: 0.92, note: "M.S. from BITS Pilani" },
        { factor: "notice_period", score: 0.4, note: "90-day notice — long lead time" },
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
        {
          factor: "experience_level",
          score: 0.82,
          note: "6 years — comfortable at L5 with growth runway",
        },
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
        {
          factor: "skills_match",
          score: 0.88,
          note: "All required skills + payments-domain depth",
        },
        { factor: "experience_level", score: 0.85, note: "7 years — solid L5" },
        {
          factor: "interview_signal",
          score: 0.9,
          note: "Strong rubric scores in tech + HR rounds",
        },
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
  // G — SEED-01 wedge candidate: stuck at tech_interview for ~7 days
  // (past the 5-day threshold). The pre-seeded pending approval hangs off
  // this application. stage_entered_at refreshes each run like the others.
  {
    appId: APP_G,
    candidateId: CAND_G,
    stage: STALE_STAGE,
    createdAtInterval: "20 days",
    stageEnteredAtInterval: "7 days",
    aiScore: 87,
    aiScoreExplanation: {
      top_factors: [
        { factor: "skills_match", score: 0.9, note: "All required skills + payments-domain depth" },
        { factor: "experience_level", score: 0.86, note: "7 years — solid L5" },
        { factor: "notice_period", score: 0.9, note: "30-day notice — quick start" },
      ],
      caveats: [],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "referral",
    transitions: [
      { from: null, to: "application_received", ageInterval: "20 days" },
      {
        from: "application_received",
        to: "recruiter_review",
        ageInterval: "16 days",
        reason: "Recruiter shortlisted on AI score + payments background",
      },
      {
        from: "recruiter_review",
        to: STALE_STAGE,
        ageInterval: "7 days",
        reason: "Passed phone screen; scheduled for technical round",
      },
    ],
  },
  // H — SEED-01 wedge candidate: second stale candidate at tech_interview
  // (~6 days). NO seeded run — H is the stage_stale scanner's live-fire
  // target, proving the automatic path once a credential is wired.
  {
    appId: APP_H,
    candidateId: CAND_H,
    stage: STALE_STAGE,
    createdAtInterval: "18 days",
    stageEnteredAtInterval: "6 days",
    aiScore: 83,
    aiScoreExplanation: {
      top_factors: [
        {
          factor: "skills_match",
          score: 0.84,
          note: "4/5 required skills; strong systems background",
        },
        { factor: "experience_level", score: 0.82, note: "6 years — comfortable at L5" },
        { factor: "notice_period", score: 0.75, note: "45-day notice" },
      ],
      caveats: [],
      scored_at: new Date().toISOString(),
      scored_by: "simulated",
    },
    source: "job_board",
    transitions: [
      { from: null, to: "application_received", ageInterval: "18 days" },
      {
        from: "application_received",
        to: "recruiter_review",
        ageInterval: "15 days",
        reason: "Recruiter shortlisted",
      },
      {
        from: "recruiter_review",
        to: STALE_STAGE,
        ageInterval: "6 days",
        reason: "Passed phone screen; scheduled for technical round",
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

// ─────────────── ONBOARD-04 onboarding case specs ───────────────
//
// Six cases spanning the lifecycle so /onboarding demos as a live board on a
// fresh seed. Dates are relative to now (like the "7d stale" recruitment
// pattern) so the screen never looks stale. Geography mix is mostly IN with
// one PH case (surfaces the statutory PH document set on screen). Buddy /
// manager on the two in_progress cases use the seeded test-user memberships.

const ONB_PROBATION_DAYS = 90;
const ONB_CHECK_IN_DAYS = [7, 14, 30] as const;

interface OnbCaseSpec {
  idx: number; // index into the ONB_* id arrays
  fullName: string;
  email: string;
  city: string;
  country: "IN" | "PH"; // persons.location_country + case geography
  status: "pre_boarding" | "day_zero" | "in_progress" | "completed";
  /** Expected start date, in days from now (negative = already started). */
  expectedStartOffsetDays: number;
  /** Actual start date, in days from now; null = not started yet. */
  actualStartOffsetDays: number | null;
  /** How long ago the case (and its accepted offer) was created, in days. */
  createdOffsetDays: number;
  /** 'buddy'/'manager' = which seeded member; null = unassigned. */
  buddy: "recruiter" | "hr_ops" | "admin" | null;
  manager: "recruiter" | "hr_ops" | "admin" | null;
  /** How many document_collection tasks to mark completed. */
  docsCompleted: number;
  /** Block exactly one (not-yet-completed) document task with this reason. */
  blockDocReason: string | null;
  /** Standard task_types to mark completed. */
  standardCompleted: string[];
  /** Standard task_types to mark in_progress. */
  standardInProgress: string[];
  /** Which check-in days (7/14/30) to mark completed. */
  checkInsCompleted: number[];
  /** completed case → resolve EVERY task, ignore the granular fields above. */
  allComplete: boolean;
  blurb: string; // console summary line
}

const ONB_CASE_SPECS: OnbCaseSpec[] = [
  // 1 — fresh pre_boarding, zero progress (the "just accepted" case).
  {
    idx: 0,
    fullName: "Aditya Menon",
    email: "aditya.menon@example.test",
    city: "Bengaluru",
    country: "IN",
    status: "pre_boarding",
    expectedStartOffsetDays: 28,
    actualStartOffsetDays: null,
    createdOffsetDays: 1,
    buddy: null,
    manager: null,
    docsCompleted: 0,
    blockDocReason: null,
    standardCompleted: [],
    standardInProgress: [],
    checkInsCompleted: [],
    allComplete: false,
    blurb: "pre_boarding · IN · fresh (0 tasks done)",
  },
  // 2 — pre_boarding, several docs collected + one BLOCKED (red line on screen).
  {
    idx: 1,
    fullName: "Kavya Reddy",
    email: "kavya.reddy@example.test",
    city: "Hyderabad",
    country: "IN",
    status: "pre_boarding",
    expectedStartOffsetDays: 14,
    actualStartOffsetDays: null,
    createdOffsetDays: 4,
    buddy: null,
    manager: null,
    docsCompleted: 4,
    blockDocReason: "Awaiting an attested copy from the candidate — flagged for follow-up",
    standardCompleted: [],
    standardInProgress: ["it_provisioning"],
    checkInsCompleted: [],
    allComplete: false,
    blurb: "pre_boarding · IN · 4 docs done, 1 blocked",
  },
  // 3 — day_zero (starting today-ish), pre-boarding wrapped up.
  {
    idx: 2,
    fullName: "Rahul Verma",
    email: "rahul.verma@example.test",
    city: "Pune",
    country: "IN",
    status: "day_zero",
    expectedStartOffsetDays: 1,
    actualStartOffsetDays: null,
    createdOffsetDays: 9,
    buddy: "hr_ops",
    manager: null,
    docsCompleted: 10,
    blockDocReason: null,
    standardCompleted: ["buddy_assignment"],
    standardInProgress: ["it_provisioning"],
    checkInsCompleted: [],
    allComplete: false,
    blurb: "day_zero · IN · docs complete, IT in progress",
  },
  // 4 — in_progress, ~40%, buddy + manager assigned.
  {
    idx: 3,
    fullName: "Divya Krishnan",
    email: "divya.krishnan@example.test",
    city: "Chennai",
    country: "IN",
    status: "in_progress",
    expectedStartOffsetDays: -5,
    actualStartOffsetDays: -5,
    createdOffsetDays: 16,
    buddy: "recruiter",
    manager: "admin",
    docsCompleted: 10,
    blockDocReason: null,
    standardCompleted: ["it_provisioning", "buddy_assignment"],
    standardInProgress: ["training"],
    checkInsCompleted: [7],
    allComplete: false,
    blurb: "in_progress · IN · ~40% · buddy+manager assigned",
  },
  // 5 — in_progress, ~75%, PH geography (shows the PH statutory doc set).
  {
    idx: 4,
    fullName: "Jose Rizal Santos",
    email: "jose.santos@example.test",
    city: "Manila",
    country: "PH",
    status: "in_progress",
    expectedStartOffsetDays: -12,
    actualStartOffsetDays: -12,
    createdOffsetDays: 24,
    buddy: "hr_ops",
    manager: "admin",
    docsCompleted: 9, // 5 common + 4 PH
    blockDocReason: null,
    standardCompleted: ["it_provisioning", "buddy_assignment", "training"],
    standardInProgress: [],
    checkInsCompleted: [7, 14],
    allComplete: false,
    blurb: "in_progress · PH · ~75% · buddy+manager assigned",
  },
  // 6 — completed, everything resolved, started ~45 days ago.
  {
    idx: 5,
    fullName: "Ananya Gupta",
    email: "ananya.gupta@example.test",
    city: "Bengaluru",
    country: "IN",
    status: "completed",
    expectedStartOffsetDays: -45,
    actualStartOffsetDays: -45,
    createdOffsetDays: 60,
    buddy: "recruiter",
    manager: "admin",
    docsCompleted: 10,
    blockDocReason: null,
    standardCompleted: [],
    standardInProgress: [],
    checkInsCompleted: [7, 14, 30],
    allComplete: true,
    blurb: "completed · IN · all tasks resolved",
  },
];

/** YYYY-MM-DD for `now + offsetDays` at UTC midnight. */
function onbDateStr(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** ISO timestamp for `now + offsetDays`. */
function onbIso(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString();
}

/** Indexed lookup that throws instead of returning undefined (no `!`). */
function onbAt(arr: readonly string[], i: number): string {
  const v = arr[i];
  if (v === undefined) throw new Error(`ONBOARD-04 seed: index ${i} out of range`);
  return v;
}

async function main() {
  // Dynamic imports so dotenv (above) runs before client.ts evaluates
  // DATABASE_URL at module init. Same pattern as seed-test-users.ts.
  const { eq } = await import("drizzle-orm");
  const { db, sql: poolSql } = await import("../client");
  const { tenants } = await import("../schema");

  const [tenant] = await db
    .select({ id: tenants.id, displayName: tenants.displayName })
    .from(tenants)
    .where(eq(tenants.slug, TENANT_SLUG))
    .limit(1);
  if (!tenant) {
    console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
    process.exit(2);
  }
  const tid = tenant.id;
  const companyName = tenant.displayName;
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

  // hr_ops1 + admin1 memberships — buddy / manager assignees for the
  // ONBOARD-04 in_progress cases. Optional: if a persona is missing (older
  // test-user seed) the assignment is simply left unset for that role.
  async function membershipByEmail(email: string): Promise<string | null> {
    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${tid} AND tum.status = 'active' AND au.email = ${email}
      LIMIT 1
    `;
    return m?.id ?? null;
  }
  const hrOpsId = await membershipByEmail(ONB_HR_OPS_EMAIL);
  const adminId = await membershipByEmail(ONB_ADMIN_EMAIL);
  const onbMemberByRole: Record<"recruiter" | "hr_ops" | "admin", string | null> = {
    recruiter: recruiterId,
    hr_ops: hrOpsId,
    admin: adminId,
  };

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
      ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email_primary = EXCLUDED.email_primary,
        email_normalised = EXCLUDED.email_normalised,
        phone_primary = EXCLUDED.phone_primary,
        phone_normalised = EXCLUDED.phone_normalised
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
  // Clear F's outbox row (AI-03 real-scoring path) — it's pending
  // until the worker drains it, so a re-seed needs a fresh row.
  await poolSql`DELETE FROM public.ai_score_outbox WHERE application_id = ${APP_F}`;
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

  // ── 3a. Candidate F — AI-03 real-scoring path ──────────────────
  //
  // Inserted outside the DEMO_APPS loop because:
  //   - aiScore is intentionally NULL (the worker fills it from the
  //     real provider response, or LocalAIClient fixture in tests).
  //   - knockout_passed is set to true because the demo requisition
  //     has no knockouts; in production submitApplication runs
  //     evaluateKnockouts() and writes the result atomically.
  //   - An ai_score_outbox row is enqueued so the apps/workers
  //     process drains it on its next 5s tick. With ANTHROPIC_API_KEY
  //     present, a real Anthropic call lands and ai_usage_logs
  //     records tokens + cost; otherwise (NODE_ENV=test or
  //     AI_CLIENT_MODE=local) the LocalAIClient handles it via the
  //     bundled fixture corpus.
  await poolSql.unsafe(`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source,
       current_stage, stage_entered_at,
       ai_score, ai_score_explanation, ai_scored_at,
       knockout_passed, knockout_failures, knockout_evaluated_at,
       created_at, updated_at)
    VALUES ('${APP_F}', '${tid}', '${CAND_F}', '${DEMO_REQ}',
            'career_site', 'application_received',
            now() - interval '5 minutes',
            NULL, NULL, NULL,
            true, NULL, now() - interval '5 minutes',
            now() - interval '5 minutes',
            now() - interval '5 minutes')
  `);
  await poolSql`
    INSERT INTO public.application_state_transitions
      (tenant_id, application_id, from_stage, to_stage,
       transitioned_at, actor_membership_id)
    VALUES (${tid}, ${APP_F}, NULL, 'application_received',
            now() - interval '5 minutes', ${recruiterId})
  `;
  await poolSql`
    INSERT INTO public.ai_score_outbox
      (tenant_id, application_id, status, created_at)
    VALUES (${tid}, ${APP_F}, 'pending', now() - interval '5 minutes')
    ON CONFLICT (tenant_id, application_id) DO NOTHING
  `;

  // ── 4. Candidate E's extended offer + signed-link token ─────────
  //
  // 7-day window from now. signLink replicates exactly what the
  // extendOffer mutation does in production — same secret, same
  // (action, subjectId, expiresAt, nonce) payload, same SHA-256
  // token_hash.
  const expiresAt = new Date(Date.now() + OFFER_E.expiryDays * 24 * 60 * 60 * 1000);
  const token = signSeedLink("candidate.accept_offer", DEMO_OFFER, expiresAt);
  const tokenHash = hashSeedToken(token);
  const joiningDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

  // ── 4a. SEED-01 — follow-ups agent + G's paused pending approval ──
  //
  // Provisions the complete Act-2 wedge state so /approvals shows a
  // real drafted message even before an Anthropic credential is wired,
  // while the live stage_stale scanner can still fire on H.
  //
  // Idempotency pattern (documented for the hand-back):
  //
  //   1. RETIRE, don't delete, any *active* agent named "Demo
  //      Follow-ups Agent" whose id ≠ our deterministic DEMO_AGENT.
  //      The dev DB carries an ADMIN-01-era agent with an INVALID
  //      trigger stage ('tech_screen') that holds the partial-unique
  //      slot `(tenant_id, name) WHERE retired_at IS NULL`; we cannot
  //      insert our agent while it's active. Retire (retired_at=now,
  //      enabled=false) preserves its append-only audit + any children.
  //
  //   2. DELETE-THEN-REINSERT our own agent block + G's paused-run rows
  //      by deterministic id, CHILD-FIRST (approval_requests →
  //      run_actions → runs → outbox → approval_rules → actions →
  //      triggers → agent). Child-first matters: agent_run_actions.
  //      action_id → agent_actions is ON DELETE RESTRICT, so a naive
  //      `DELETE automation_agents` cascade could trip the restrict
  //      mid-cascade. Deleting run_actions before actions sidesteps it.
  //      Re-seeding every run refreshes proposed_at/triggered_at (a
  //      "recent" approval) and resets H's live-fire target if the
  //      scanner enqueued anything between seeds — all rows are ours.
  //
  // The seeded run mirrors the exact end-state a real drain reaches when
  // it halts on the draft_message approval gate (agent-vertical-smoke +
  // agent-approval-vertical-smoke): outbox/run 'awaiting_approval', a
  // single draft_message run_action 'awaiting_approval' carrying the
  // draft output, and a 'pending' agent_approval_requests row whose
  // proposed_action_payload IS that draft.

  // Step 1 — retire stale active namesakes (e.g. the tech_screen agent).
  const retired = await poolSql<{ id: string }[]>`
    UPDATE public.automation_agents
    SET retired_at = now(), enabled = false, updated_at = now()
    WHERE tenant_id = ${tid}
      AND name = ${DEMO_AGENT_NAME}
      AND id <> ${DEMO_AGENT}
      AND retired_at IS NULL
    RETURNING id::text AS id
  `;

  // Step 2a — child-first teardown of our own deterministic rows.
  await poolSql`DELETE FROM public.agent_approval_requests WHERE agent_id = ${DEMO_AGENT}`;
  await poolSql`
    DELETE FROM public.agent_run_actions
    WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${DEMO_AGENT})
  `;
  await poolSql`DELETE FROM public.agent_runs WHERE agent_id = ${DEMO_AGENT}`;
  await poolSql`DELETE FROM public.agent_run_outbox WHERE agent_id = ${DEMO_AGENT}`;
  await poolSql`DELETE FROM public.agent_approval_rules WHERE agent_id = ${DEMO_AGENT}`;
  await poolSql`DELETE FROM public.agent_actions WHERE agent_id = ${DEMO_AGENT}`;
  await poolSql`DELETE FROM public.agent_triggers WHERE agent_id = ${DEMO_AGENT}`;
  await poolSql`DELETE FROM public.automation_agents WHERE id = ${DEMO_AGENT}`;

  // Step 2b — the agent + its curated 2-action follow-up chain. Shapes
  // copied field-for-field from createFollowUpAgent (apps/api router):
  // trigger_config omits the `type` discriminator; draft action gates on
  // human_required/owning_recruiter; send action is auto (approver NULL).
  await poolSql`
    INSERT INTO public.automation_agents
      (id, tenant_id, agent_type, name, description, enabled, version, created_by)
    VALUES (${DEMO_AGENT}, ${tid}, 'follow_up', ${DEMO_AGENT_NAME},
            'Drafts friendly check-in messages to candidates who have sat in a stage past the threshold, then sends on recruiter approval.',
            true, 1, ${recruiterId})
  `;
  await poolSql`
    INSERT INTO public.agent_triggers
      (id, tenant_id, agent_id, trigger_type, trigger_config)
    VALUES (${DEMO_AGENT_TRIGGER}, ${tid}, ${DEMO_AGENT}, 'stage_stale',
            ${JSON.stringify({ stage: STALE_STAGE, days_threshold: STALE_DAYS_THRESHOLD })}::jsonb)
  `;
  await poolSql`
    INSERT INTO public.agent_actions
      (id, tenant_id, agent_id, action_order, action_type, action_config)
    VALUES (${DEMO_DRAFT_ACTION}, ${tid}, ${DEMO_AGENT}, 1, 'draft_message',
            ${JSON.stringify({ template_prompt_id: "follow_up_v1", tone: FOLLOWUP_TONE, max_tokens: FOLLOWUP_MAX_TOKENS })}::jsonb)
  `;
  await poolSql`
    INSERT INTO public.agent_actions
      (id, tenant_id, agent_id, action_order, action_type, action_config)
    VALUES (${DEMO_SEND_ACTION}, ${tid}, ${DEMO_AGENT}, 2, 'send_message',
            ${JSON.stringify({ channel: "email", outbox_kind: "agent_followup", requires_approval: false })}::jsonb)
  `;
  await poolSql`
    INSERT INTO public.agent_approval_rules
      (id, tenant_id, agent_id, action_id, approval_mode, approver_role)
    VALUES (${DEMO_DRAFT_RULE}, ${tid}, ${DEMO_AGENT}, ${DEMO_DRAFT_ACTION},
            'human_required', 'owning_recruiter')
  `;
  await poolSql`
    INSERT INTO public.agent_approval_rules
      (id, tenant_id, agent_id, action_id, approval_mode, approver_role)
    VALUES (${DEMO_SEND_RULE}, ${tid}, ${DEMO_AGENT}, ${DEMO_SEND_ACTION},
            'auto', NULL)
  `;

  // Step 2c — G's paused run. trigger_context matches the scanner's
  // jsonb_build_object shape EXACTLY (application_id, trigger, stage) so
  // an approve → resume in the drain re-probes and finds this run.
  const gTriggerContext = {
    application_id: APP_G,
    trigger: "stage_stale",
    stage: STALE_STAGE,
  };
  const gTriggerContextJson = JSON.stringify(gTriggerContext);

  // The drafted email the recruiter sees in /approvals. Field-for-field
  // the draftMessageExecutor output shape (packages/agent-actions):
  // draft_text + executor-owned subject + the flat application context.
  const gDraftText =
    `Hi Rohan,\n\n` +
    `I wanted to check in on your application for the Senior Backend Engineer ` +
    `role at ${companyName}. You've been at the technical interview stage for ` +
    `about a week now, and I didn't want you to feel out of the loop while we ` +
    `line up the next round with the panel.\n\n` +
    `We're still very much moving forward — I'm coordinating the interviewers' ` +
    `availability and expect to confirm a slot for you shortly. If anything has ` +
    `changed on your end, or if you have any questions in the meantime, just ` +
    `reply here and I'll get back to you the same day.\n\n` +
    `Thanks for your patience, and talk soon.\n\n` +
    `Warm regards,\nThe Talent Team`;
  const gDraftPayload = {
    draft_text: gDraftText,
    subject: "Update on your application — Senior Backend Engineer",
    application_id: APP_G,
    candidate_id: CAND_G,
    candidate_name: "Rohan Desai",
    candidate_email: "digitalfuturity@outlook.com",
    position_title: "Senior Backend Engineer",
    company_name: companyName,
    stage: STALE_STAGE,
    days_in_stage: 7,
    template_prompt_id: "follow_up_v1",
    prompt_version: "followup-v1",
    tone: FOLLOWUP_TONE,
  };
  const gDraftPayloadJson = JSON.stringify(gDraftPayload);
  // The run_action.input snapshot the drain records: {config, triggerContext}.
  const gRunActionInputJson = JSON.stringify({
    config: {
      template_prompt_id: "follow_up_v1",
      tone: FOLLOWUP_TONE,
      max_tokens: FOLLOWUP_MAX_TOKENS,
    },
    triggerContext: gTriggerContext,
  });

  // agent_runs — 'awaiting_approval', triggered_by='system' (so
  // triggered_by_user_id stays NULL per the CHECK), cost rolled from the
  // draft LLM call.
  await poolSql`
    INSERT INTO public.agent_runs
      (id, tenant_id, agent_id, triggered_by, triggered_by_user_id,
       triggered_at, trigger_context, status, cost_micros)
    VALUES (${DEMO_RUN_G}, ${tid}, ${DEMO_AGENT}, 'system', NULL,
            now() - interval '4 minutes', ${gTriggerContextJson}::jsonb,
            'awaiting_approval', ${"3800"}::bigint)
  `;
  // agent_run_outbox — 'awaiting_approval' (out of polling rotation).
  // trigger_context byte-identical to the run's. This is also the dedup
  // marker: the scanner's NOT EXISTS on (agent_id, application_id) means
  // G will NOT double-fire while this row exists — by design.
  await poolSql`
    INSERT INTO public.agent_run_outbox
      (id, tenant_id, agent_id, trigger_context, status,
       enqueued_at, started_at, locked_until, attempt_count)
    VALUES (${DEMO_OUTBOX_G}, ${tid}, ${DEMO_AGENT}, ${gTriggerContextJson}::jsonb,
            'awaiting_approval', now() - interval '4 minutes',
            now() - interval '4 minutes', now() - interval '1 minute', 1)
  `;
  // agent_run_actions — action 1 (draft_message) 'awaiting_approval',
  // output = the draft, back-pointer to the approval request. Action 2
  // (send_message) has NO row yet — it executes for the first time on
  // resume, exactly as the drain does.
  await poolSql`
    INSERT INTO public.agent_run_actions
      (id, tenant_id, run_id, action_id, action_order, status,
       started_at, input, output, approval_request_id)
    VALUES (${DEMO_RUN_ACTION_G}, ${tid}, ${DEMO_RUN_G}, ${DEMO_DRAFT_ACTION}, 1,
            'awaiting_approval', now() - interval '4 minutes',
            ${gRunActionInputJson}::jsonb, ${gDraftPayloadJson}::jsonb,
            ${DEMO_APPROVAL_G})
  `;
  // agent_approval_requests — 'pending', proposed_action_payload IS the
  // draft, approver_role 'owning_recruiter', proposed_at recent, ttl_at
  // NULL (human_required carries no TTL — matches the smoke tests).
  await poolSql`
    INSERT INTO public.agent_approval_requests
      (id, tenant_id, run_id, run_action_id, agent_id, proposed_at,
       proposed_action_summary, proposed_action_payload, approver_role,
       status, ttl_at)
    VALUES (${DEMO_APPROVAL_G}, ${tid}, ${DEMO_RUN_G}, ${DEMO_RUN_ACTION_G}, ${DEMO_AGENT},
            now() - interval '4 minutes', 'draft_message requires approval',
            ${gDraftPayloadJson}::jsonb, 'owning_recruiter', 'pending', NULL)
  `;

  // ── 4b. ONBOARD-04 onboarding demo cases ────────────────────────
  //
  // Six cases across the lifecycle so /onboarding is a live board on a fresh
  // seed. Idempotency: each case's application is delete-then-reinserted by
  // deterministic id — deleting an application CASCADES its onboarding_case →
  // tasks / documents / bgv / IT / assets and its offers, so a re-run
  // rebuilds the case from scratch with refreshed relative timestamps.
  // application_state_transitions do NOT cascade, so clear them first.
  //
  // Checklist generation MIRRORS apps/api/src/lib/onboarding-case.ts (not
  // imported — packages/db must not depend on apps/api): document_collection
  // tasks INSERT…SELECT from document_types (common + geography rows), then
  // the 7 standard tasks. Per-case progress is then layered on with targeted
  // UPDATEs so the board shows a spread of states (incl. one blocked task
  // with a reason — a visible red line for the demo).
  for (const id of ONB_APP_IDS) {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${id}`;
    // OFFBOARD-01 anchors offboarding_cases on applications with RESTRICT
    // (deliberate: departure records must survive recruitment-side deletes in
    // production). The demo seed cycle is the sanctioned exception — clear
    // any offboarding cases (children cascade from the case) referencing
    // this application before the delete-recreate, or the FK blocks it.
    await poolSql`DELETE FROM public.offboarding_cases WHERE application_id = ${id}`;
    // Deleting the application cascades onboarding_cases → tasks/docs/etc + offers.
    await poolSql`DELETE FROM public.applications WHERE id = ${id}`;
  }

  for (const spec of ONB_CASE_SPECS) {
    const personId = onbAt(ONB_PERSON_IDS, spec.idx);
    const candidateId = onbAt(ONB_CANDIDATE_IDS, spec.idx);
    const appId = onbAt(ONB_APP_IDS, spec.idx);
    const caseId = onbAt(ONB_CASE_IDS, spec.idx);
    const offerId = onbAt(ONB_OFFER_IDS, spec.idx);
    const phone = `+9198765432${String(10 + spec.idx)}`;

    // person + candidate (stable content → upsert / do-nothing).
    await poolSql`
      INSERT INTO public.persons
        (id, tenant_id, full_name, email_primary, email_normalised,
         phone_primary, phone_normalised, location_country, location_city)
      VALUES (${personId}, ${tid}, ${spec.fullName}, ${spec.email}, ${spec.email.toLowerCase()},
              ${phone}, ${phone.replace(/[^0-9]/g, "")}, ${spec.country}, ${spec.city})
      ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email_primary = EXCLUDED.email_primary,
        email_normalised = EXCLUDED.email_normalised,
        location_country = EXCLUDED.location_country,
        location_city = EXCLUDED.location_city
    `;
    await poolSql`
      INSERT INTO public.candidates
        (id, tenant_id, person_id, source, consent_version, years_of_experience)
      VALUES (${candidateId}, ${tid}, ${personId}, 'referral', 'v1', '6.0')
      ON CONFLICT (id) DO NOTHING
    `;

    // application at offer_accepted — the post-accept state onboarding sits on.
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source,
         current_stage, stage_entered_at, created_at, updated_at)
      VALUES (${appId}, ${tid}, ${candidateId}, ${DEMO_REQ}, 'referral',
              'offer_accepted', ${onbIso(-spec.createdOffsetDays)}::timestamptz,
              ${onbIso(-spec.createdOffsetDays)}::timestamptz,
              ${onbIso(-spec.createdOffsetDays)}::timestamptz)
    `;
    await poolSql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, transitioned_at, actor_membership_id)
      VALUES (${tid}, ${appId}, NULL, 'offer_accepted',
              ${onbIso(-spec.createdOffsetDays)}::timestamptz, ${recruiterId})
    `;

    // accepted offer (joining_date = expected start) — coherence with the
    // real accept→onboard path, though the screen reads dates off the case.
    const expectedStart = onbDateStr(spec.expectedStartOffsetDays);
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id,
         base_salary_inr_paise, joining_date, location, expiry_at,
         status, extended_at, accepted_at, created_at, updated_at)
      VALUES (${offerId}, ${tid}, ${appId}, ${recruiterId},
              ${"420000000"}::bigint, ${expectedStart}, ${spec.city},
              ${onbIso(-spec.createdOffsetDays + 7)}::timestamptz,
              'accepted', ${onbIso(-spec.createdOffsetDays)}::timestamptz,
              ${onbIso(-spec.createdOffsetDays)}::timestamptz,
              ${onbIso(-spec.createdOffsetDays)}::timestamptz,
              ${onbIso(-spec.createdOffsetDays)}::timestamptz)
    `;

    // onboarding_case (deterministic id). probation_ends_at = start + 90.
    const actualStart =
      spec.actualStartOffsetDays !== null ? onbDateStr(spec.actualStartOffsetDays) : null;
    const probationEnds = onbDateStr(spec.expectedStartOffsetDays + ONB_PROBATION_DAYS);
    const buddyId = spec.buddy ? onbMemberByRole[spec.buddy] : null;
    const managerId = spec.manager ? onbMemberByRole[spec.manager] : null;
    // ONBOARD-06 follow-up: cases past pre_boarding have been "hired in
    // Workday" (simulated) — pre-stamp a deterministic Worker ID (a58x
    // namespace) so the "Hired in Workday" badge shows on a fresh seed.
    // The live path (day_zero advance → outbox → sim drain write-back)
    // only fires for cases advanced through updateOnboardingCase.
    const workdayWorkerId =
      spec.status === "pre_boarding" ? null : `00000000-0000-4000-8000-00000000a58${spec.idx}`;
    await poolSql`
      INSERT INTO public.onboarding_cases
        (id, tenant_id, application_id, candidate_id, status, geography_code,
         expected_start_date, actual_start_date, probation_days, probation_ends_at,
         buddy_membership_id, manager_membership_id, workday_worker_id, created_at, updated_at)
      VALUES (${caseId}, ${tid}, ${appId}, ${candidateId}, ${spec.status}, ${spec.country},
              ${expectedStart}::date, ${actualStart}::date, ${ONB_PROBATION_DAYS}, ${probationEnds}::date,
              ${buddyId}, ${managerId}, ${workdayWorkerId},
              ${onbIso(-spec.createdOffsetDays)}::timestamptz, ${onbIso(-spec.createdOffsetDays)}::timestamptz)
    `;

    // document_collection tasks — common + geography rows (mirror of
    // ensureDocumentCollectionTasks). Names/metadata come straight from the
    // document_types reference so they match the production checklist.
    await poolSql`
      INSERT INTO public.onboarding_tasks
        (tenant_id, case_id, task_type, status, title, metadata)
      SELECT ${tid}, ${caseId}, 'document_collection', 'pending', dt.name,
             jsonb_build_object('documentTypeId', dt.id, 'documentTypeCode', dt.code,
                                'geographyCode', dt.geography_code)
      FROM public.document_types dt
      WHERE dt.required_for_lifecycle_stage = 'pre_boarding'
        AND (dt.geography_code IS NULL OR dt.geography_code = ${spec.country})
    `;

    // standard tasks (mirror of createStandardTasks): IT, buddy, training,
    // day 7/14/30 check-ins, probation review. Check-in due_at = start + N.
    await poolSql`
      INSERT INTO public.onboarding_tasks (tenant_id, case_id, task_type, status, title)
      VALUES
        (${tid}, ${caseId}, 'it_provisioning', 'pending', 'Provision IT accounts, email, and equipment'),
        (${tid}, ${caseId}, 'buddy_assignment', 'pending', 'Assign an onboarding buddy'),
        (${tid}, ${caseId}, 'training', 'pending', 'Complete mandatory onboarding training')
    `;
    for (const day of ONB_CHECK_IN_DAYS) {
      await poolSql`
        INSERT INTO public.onboarding_tasks
          (tenant_id, case_id, task_type, status, title, due_at, metadata)
        VALUES (${tid}, ${caseId}, 'check_in', 'pending', ${`Day ${day} check-in`},
                ${onbIso(spec.expectedStartOffsetDays + day)}::timestamptz,
                ${JSON.stringify({ checkInDay: day })}::jsonb)
      `;
    }
    await poolSql`
      INSERT INTO public.onboarding_tasks
        (tenant_id, case_id, task_type, status, title, due_at, metadata)
      VALUES (${tid}, ${caseId}, 'probation_review', 'pending', 'Probation review',
              ${onbIso(spec.expectedStartOffsetDays + ONB_PROBATION_DAYS)}::timestamptz,
              ${JSON.stringify({ probationDays: ONB_PROBATION_DAYS })}::jsonb)
    `;

    // ── progress overlay ──
    if (spec.allComplete) {
      // Completed case: resolve EVERY task.
      await poolSql`
        UPDATE public.onboarding_tasks
        SET status = 'completed', completed_at = ${onbIso(-2)}::timestamptz, updated_at = ${onbIso(-2)}::timestamptz
        WHERE case_id = ${caseId} AND status <> 'completed'
      `;
    } else {
      // N document tasks → completed (ordered by title for determinism).
      if (spec.docsCompleted > 0) {
        await poolSql`
          UPDATE public.onboarding_tasks
          SET status = 'completed', completed_at = ${onbIso(-3)}::timestamptz, updated_at = ${onbIso(-3)}::timestamptz
          WHERE id IN (
            SELECT id FROM public.onboarding_tasks
            WHERE case_id = ${caseId} AND task_type = 'document_collection'
            ORDER BY title LIMIT ${spec.docsCompleted}
          )
        `;
      }
      // One still-pending document task → blocked (the demo red line).
      if (spec.blockDocReason) {
        await poolSql`
          UPDATE public.onboarding_tasks
          SET status = 'blocked', blocked_reason = ${spec.blockDocReason}, updated_at = ${onbIso(-2)}::timestamptz
          WHERE id = (
            SELECT id FROM public.onboarding_tasks
            WHERE case_id = ${caseId} AND task_type = 'document_collection' AND status = 'pending'
            ORDER BY title LIMIT 1
          )
        `;
      }
      // Standard tasks → completed / in_progress.
      for (const t of spec.standardCompleted) {
        await poolSql`
          UPDATE public.onboarding_tasks
          SET status = 'completed', completed_at = ${onbIso(-3)}::timestamptz, updated_at = ${onbIso(-3)}::timestamptz
          WHERE case_id = ${caseId} AND task_type = ${t}
        `;
      }
      for (const t of spec.standardInProgress) {
        await poolSql`
          UPDATE public.onboarding_tasks
          SET status = 'in_progress', updated_at = ${onbIso(-1)}::timestamptz
          WHERE case_id = ${caseId} AND task_type = ${t}
        `;
      }
      // Completed check-ins (matched by metadata.checkInDay).
      for (const day of spec.checkInsCompleted) {
        await poolSql`
          UPDATE public.onboarding_tasks
          SET status = 'completed', completed_at = ${onbIso(-2)}::timestamptz, updated_at = ${onbIso(-2)}::timestamptz
          WHERE case_id = ${caseId} AND task_type = 'check_in'
            AND (metadata->>'checkInDay')::int = ${day}
        `;
      }
    }
  }

  // ── 5. summary ──────────────────────────────────────────────────
  const acceptUrl = `${PORTAL_BASE}/offer/${token}`;
  console.log("");
  console.log(`Seeded ${DEMO_APPS.length + 1} applications under requisition ${DEMO_REQ}`);
  console.log(
    "  A. Anika Raghavan      application_received   score=92   2h ago   (MomentumFeed top)",
  );
  console.log(
    "  B. Vikram Joshi        application_received   score=64   6h ago   (MomentumFeed mid)",
  );
  console.log(
    "  C. Sneha Banerjee      application_received   score=88   30h ago  (Hot Zone — SLA breach)",
  );
  console.log(
    "  D. Karthik Mahadevan   recruiter_review       score=81   2d in stage  (drawer demo)",
  );
  console.log("  E. Priya Subramanian   offer_drafted          score=85   offer extended 1h ago");
  console.log(
    "  F. Aarav Iyer          application_received   score=PENDING   5m ago  (AI-03 real scoring)",
  );
  console.log(
    "  G. Rohan Desai         tech_interview         score=87   7d in stage  (SEED-01 pending approval)",
  );
  console.log(
    "  H. Meera Nair          tech_interview         score=83   6d in stage  (SEED-01 scanner live-fire)",
  );
  console.log("");
  console.log("SEED-01 follow-ups wedge:");
  console.log(`  Agent:    ${DEMO_AGENT_NAME}  (${DEMO_AGENT})`);
  console.log(
    `            follow_up · stage_stale · stage=${STALE_STAGE} · days_threshold=${STALE_DAYS_THRESHOLD} · enabled`,
  );
  if (retired.length > 0) {
    console.log(
      `            retired ${retired.length} stale active namesake(s): ${retired.map((r) => r.id).join(", ")}`,
    );
  }
  console.log(
    `  Approval: ${DEMO_APPROVAL_G}  (pending, owning_recruiter) — G's drafted check-in, visible at /approvals`,
  );
  console.log("");
  console.log(`ONBOARD-04 onboarding cases (${ONB_CASE_SPECS.length}) at /onboarding:`);
  for (const spec of ONB_CASE_SPECS) {
    console.log(`  ${spec.fullName.padEnd(20)} ${spec.blurb}`);
  }
  console.log(
    `  buddy/manager assignees: recruiter1${hrOpsId ? " + hr_ops1" : ""}${adminId ? " + admin1" : ""}`,
  );
  console.log(`  Run:      ${DEMO_RUN_G}  (awaiting_approval, halted on draft_message)`);
  console.log(`  H (${APP_H}) has NO seeded run — the stage_stale scanner live-fires on it.`);
  console.log("");
  console.log("Candidate E offer-accept URL (single-use, expires in 7 days):");
  console.log(`  ${acceptUrl}`);
  console.log("");
  console.log("Public apply URL (CRS-01, anyone can submit):");
  console.log(`  ${PORTAL_BASE}/t/${TENANT_SLUG}/apply/gcc-blr-senior-backend`);
  console.log("");
  console.log("Candidate F is pending real AI scoring (ai_score_outbox row).");
  console.log("Boot apps/workers with ANTHROPIC_API_KEY set to drain via the live");
  console.log("provider; otherwise the LocalAIClient fixture corpus handles it in");
  console.log("test mode.");
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
