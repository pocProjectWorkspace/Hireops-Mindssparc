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

// ─────────────── SEED-02 Problem 3 — H's second pending approval ───────────────
//
// A SECOND believable pending approval on the same agent for candidate H
// (Meera Nair), so /approvals shows TWO entries that OPEN with full detail
// (Rohan a599 + Meera). Ids in the free a5ax slots (a5a0 is the position; a5a1+
// are unused). Same halted-draft end-state as G.
const DEMO_RUN_H = "00000000-0000-4000-8000-00000000a5a1";
const DEMO_RUN_ACTION_H = "00000000-0000-4000-8000-00000000a5a2";
const DEMO_OUTBOX_H = "00000000-0000-4000-8000-00000000a5a3";
const DEMO_APPROVAL_H = "00000000-0000-4000-8000-00000000a5a4";

// ─────────────── SEED-02 Problem 1 — interviews on the demo requisition ─────────
//
// Interview PLANS (rounds) live per-requisition; INTERVIEWS instantiate them.
// Deterministic interview ids in the free a5dx slots (a5d0 is the JD). Panelists
// + feedback use default ids (they cascade when the interview is deleted).
const IV_D_SCHEDULED = "00000000-0000-4000-8000-00000000a5d1"; // Karthik (D) — upcoming, pending confirm
const IV_C_CONFIRMED = "00000000-0000-4000-8000-00000000a5d2"; // Sneha (C) — upcoming, candidate-confirmed
const IV_E_COMPLETED = "00000000-0000-4000-8000-00000000a5d3"; // Priya (E) — completed w/ panel1 scorecard

const PANEL_EMAIL = "panel1@kyndryl-poc.test";
const HIRING_MANAGER_EMAIL = "hiringmanager1@kyndryl-poc.test";
const HR_HEAD_EMAIL = "hrhead1@kyndryl-poc.test";

// ─────────────── SEED-02 Problems 5/6 — extra requisitions + approval spine ────
//
// Five more requisitions so the apply portal + HR-head queue + approval history
// all demo on a fresh seed. All ids in the free a5bx block (a5b0 is the demo BU).
// Two are POSTED with working public apply URLs (Problem 5); the rest drive the
// HR-head approvals queue's variety (Problem 6). The approval spine (matrix +
// chain + requests + decisions) sits in the free a5ex block (a5e0 is the envelope).
interface ExtraReq {
  key: string;
  positionId: string;
  jdId: string;
  reqId: string;
  title: string;
  slug: string;
  primaryLocation: string;
  locationType: "hybrid" | "remote" | "onsite";
  openings: number;
  compMin: string; // numeric(12,2) as string
  compMax: string;
  jdText: string;
  skills: string[];
  knockouts: { question: string; type: string; threshold: unknown }[];
  // Requisition + approval lifecycle for the demo.
  reqStatus: "posted" | "pending_approval" | "draft";
  posted: boolean; // status posted → set posted_at + is_public
  /** Approval-queue role: how this req appears in the HR-head queue. */
  approval: "approved" | "pending_clean" | "pending_bias" | "sent_back" | "none";
}

const EXTRA_REQS: ExtraReq[] = [
  {
    key: "data-platform",
    positionId: "00000000-0000-4000-8000-00000000a5b1",
    jdId: "00000000-0000-4000-8000-00000000a5b2",
    reqId: "00000000-0000-4000-8000-00000000a5b3",
    title: "Data Platform Engineer",
    slug: "gcc-blr-data-platform-engineer",
    primaryLocation: "Bengaluru",
    locationType: "hybrid",
    openings: 2,
    compMin: "3800000.00",
    compMax: "5200000.00",
    jdText: `# Data Platform Engineer — GCC Bengaluru

## About the role
Own the batch + streaming data platform the analytics and ML teams build on.
You'll run the lakehouse, the orchestration layer, and the self-serve data
tooling that keeps the org's data trustworthy and fast.

## What you'll do
- Operate Spark / Flink pipelines and an Iceberg-based lakehouse on AWS.
- Own Airflow orchestration and data-quality contracts across domains.
- Partner with analytics engineers on dbt models and semantic layers.

## Must-have
- 4+ years in data engineering (Python + SQL at depth).
- Spark or Flink in production; strong dimensional-modelling instincts.
- AWS (S3, Glue, EMR/MSK) and infrastructure-as-code.

## Nice-to-have
- Iceberg / Delta, dbt, Airflow authoring at scale.
- Streaming CDC (Debezium / Kafka Connect).

## Logistics
- Bengaluru, hybrid (3 days/week). L5, reporting to the Data Platform EM.
`,
    skills: ["Python", "SQL", "Apache Spark", "AWS", "Airflow"],
    knockouts: [
      {
        question: "Years of data-engineering experience",
        type: "numeric_min",
        threshold: { min: 4 },
      },
    ],
    reqStatus: "posted",
    posted: true,
    approval: "approved",
  },
  {
    key: "product-designer",
    positionId: "00000000-0000-4000-8000-00000000a5b4",
    jdId: "00000000-0000-4000-8000-00000000a5b5",
    reqId: "00000000-0000-4000-8000-00000000a5b6",
    title: "Product Designer",
    slug: "gcc-blr-product-designer",
    primaryLocation: "Bengaluru",
    locationType: "hybrid",
    openings: 1,
    compMin: "2800000.00",
    compMax: "4200000.00",
    jdText: `# Product Designer — GCC Bengaluru

## About the role
Shape end-to-end product experiences for the internal platform suite — from
early problem framing through polished, accessible interfaces the whole org
relies on daily.

## What you'll do
- Own discovery-to-delivery for a product area; run research and usability tests.
- Build and extend the design system alongside engineering.
- Hold the bar on accessibility (WCAG 2.1 AA) and interaction quality.

## Must-have
- 4+ years designing complex web products (Figma fluency).
- A portfolio showing systems thinking, not just screens.
- Comfort partnering closely with PM + engineering.

## Nice-to-have
- Design-systems / tokens experience.
- Light prototyping in code (HTML/CSS).

## Logistics
- Bengaluru, hybrid (3 days/week). Reports to the Head of Design.
`,
    skills: ["Figma", "Interaction Design", "User Research", "Design Systems", "Accessibility"],
    knockouts: [{ question: "Portfolio provided", type: "boolean", threshold: { required: true } }],
    reqStatus: "posted",
    posted: true,
    approval: "none",
  },
  {
    key: "eng-manager",
    positionId: "00000000-0000-4000-8000-00000000a5b7",
    jdId: "00000000-0000-4000-8000-00000000a5b8",
    reqId: "00000000-0000-4000-8000-00000000a5b9",
    title: "Engineering Manager, Platform",
    slug: "gcc-blr-engineering-manager-platform",
    primaryLocation: "Bengaluru",
    locationType: "hybrid",
    openings: 1,
    compMin: "6500000.00",
    compMax: "9000000.00",
    jdText: `# Engineering Manager, Platform — GCC Bengaluru

## About the role
Lead the platform engineering squad — people, delivery, and technical
direction for the services every internal product depends on.

## What you'll do
- Manage and grow a team of 6–8 engineers; own hiring and career growth.
- Partner with product on roadmap and delivery predictability.
- Keep the platform reliable, observable, and cost-aware.

## Must-have
- 3+ years managing software engineers.
- A background building distributed backend services.
- Track record of shipping and of growing people.

## Logistics
- Bengaluru, hybrid. Reports to the Director of Engineering.
`,
    skills: ["People Management", "Distributed Systems", "Delivery", "Stakeholder Management"],
    knockouts: [
      { question: "Years managing engineers", type: "numeric_min", threshold: { min: 3 } },
    ],
    reqStatus: "pending_approval",
    posted: false,
    approval: "pending_clean",
  },
  {
    key: "data-scientist",
    positionId: "00000000-0000-4000-8000-00000000a5ba",
    jdId: "00000000-0000-4000-8000-00000000a5bb",
    reqId: "00000000-0000-4000-8000-00000000a5bc",
    title: "Senior Data Scientist",
    slug: "gcc-blr-senior-data-scientist",
    primaryLocation: "Bengaluru",
    locationType: "hybrid",
    openings: 1,
    compMin: "4200000.00",
    compMax: "6000000.00",
    jdText: `# Senior Data Scientist — GCC Bengaluru

## About the role
We're after a rockstar data scientist and analytics ninja to own forecasting
and experimentation across the org. (Deliberately un-inclusive phrasing so the
HR head sees the bias gate's warnings in the approval view.)

## Must-have
- 5+ years in applied ML / statistics (Python).
- Experimentation, causal inference, and forecasting at depth.

## Logistics
- Bengaluru, hybrid. Reports to the Head of Data Science.
`,
    skills: ["Python", "Machine Learning", "Statistics", "Experimentation"],
    knockouts: [{ question: "Years in applied ML", type: "numeric_min", threshold: { min: 5 } }],
    reqStatus: "pending_approval",
    posted: false,
    approval: "pending_bias",
  },
  {
    key: "principal-sre",
    positionId: "00000000-0000-4000-8000-00000000a5bd",
    jdId: "00000000-0000-4000-8000-00000000a5be",
    reqId: "00000000-0000-4000-8000-00000000a5bf",
    title: "Principal Site Reliability Engineer",
    slug: "gcc-blr-principal-sre",
    primaryLocation: "Bengaluru",
    locationType: "remote",
    openings: 1,
    compMin: "5500000.00",
    compMax: "7800000.00",
    jdText: `# Principal Site Reliability Engineer — GCC Bengaluru

## About the role
Set the reliability strategy for the platform — SLOs, incident response, and
the automation that keeps a growing system healthy.

## Must-have
- 8+ years in SRE / infrastructure with production ownership.
- Deep Kubernetes, observability, and incident-command experience.

## Logistics
- Remote (India). Reports to the VP of Engineering.
`,
    skills: ["Kubernetes", "Observability", "Incident Response", "Terraform"],
    knockouts: [{ question: "Years in SRE / infra", type: "numeric_min", threshold: { min: 8 } }],
    reqStatus: "draft",
    posted: false,
    approval: "sent_back",
  },
];

// Approval-spine ids (a5e0 is the envelope; e1–e8 free).
const APPROVAL_MATRIX = "00000000-0000-4000-8000-00000000a5e1";
const APPROVAL_CHAIN = "00000000-0000-4000-8000-00000000a5e2";
const APPR_REQ_DATA_PLATFORM = "00000000-0000-4000-8000-00000000a5e3";
const APPR_DEC_DATA_PLATFORM = "00000000-0000-4000-8000-00000000a5e4";
const APPR_REQ_ENG_MANAGER = "00000000-0000-4000-8000-00000000a5e5";
const APPR_REQ_DATA_SCIENTIST = "00000000-0000-4000-8000-00000000a5e6";
const APPR_REQ_PRINCIPAL_SRE = "00000000-0000-4000-8000-00000000a5e7";
const APPR_DEC_PRINCIPAL_SRE = "00000000-0000-4000-8000-00000000a5e8";

// SEED-02 Problem 4 — seeded onboarding documents (a5f0 is offer E; f1/f2 free).
const ONB_DOC_VERIFIED = "00000000-0000-4000-8000-00000000a5f1";
const ONB_DOC_PENDING = "00000000-0000-4000-8000-00000000a5f2";

// SEED-02 Problem 1 — interview_plans round templates. Modes ∈ video|onsite|
// phone; scorecard_template ∈ technical|manager|hr|general; competencies are the
// template's criteria keys (advisory display strings).
interface PlanRound {
  round: number;
  name: string;
  duration: number;
  mode: "video" | "onsite" | "phone";
  template: "technical" | "manager" | "hr" | "general";
  competencies: string[];
}
const ENGINEERING_ROUNDS: PlanRound[] = [
  {
    round: 1,
    name: "Technical deep-dive",
    duration: 60,
    mode: "video",
    template: "technical",
    competencies: ["problem_solving", "technical_depth", "code_quality"],
  },
  {
    round: 2,
    name: "System design",
    duration: 60,
    mode: "video",
    template: "technical",
    competencies: ["system_design", "communication"],
  },
  {
    round: 3,
    name: "Hiring manager conversation",
    duration: 45,
    mode: "onsite",
    template: "manager",
    competencies: ["ownership", "stakeholder_management"],
  },
  {
    round: 4,
    name: "HR round",
    duration: 30,
    mode: "video",
    template: "hr",
    competencies: ["culture_alignment", "motivation"],
  },
];
const DESIGN_ROUNDS: PlanRound[] = [
  {
    round: 1,
    name: "Portfolio review",
    duration: 60,
    mode: "video",
    template: "general",
    competencies: ["role_competence", "communication"],
  },
  {
    round: 2,
    name: "Design exercise",
    duration: 60,
    mode: "onsite",
    template: "general",
    competencies: ["problem_solving", "collaboration"],
  },
  {
    round: 3,
    name: "Hiring manager conversation",
    duration: 45,
    mode: "video",
    template: "manager",
    competencies: ["ownership", "stakeholder_management"],
  },
];

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

// SEED-02 Problem 2: human, client-legible display name (was the ticket-ish
// "Demo Follow-ups Agent"). Display name only — the agent_type code identifier
// ('follow_up') is unchanged, and protection everywhere is by id (…a590).
const DEMO_AGENT_NAME = "Stalled candidate follow-up";
const DEMO_AGENT_DESCRIPTION =
  "Watches candidates who have sat in a stage past the SLA and drafts a warm, " +
  "personalised check-in with Claude — then waits for a recruiter to approve it " +
  "before anything is sent.";
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

  // Close the pool in the finally so the script exits promptly instead of
  // hanging on idle postgres-js connections (the documented pooler-hang
  // class) — the same idiom every other seed script uses.
  try {
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

    // SEED-02: panelist / hiring-manager / hr-head memberships. These drive the
    // interview panel (Problem 1) and the requisition-approval spine (Problems
    // 5/6). Resolved via the same helper; a missing persona is a hard error for
    // the sections that need it, so fail loud if the five-seed runbook order
    // (test-users first) was skipped.
    const panelId = await membershipByEmail(PANEL_EMAIL);
    const hiringManagerId = await membershipByEmail(HIRING_MANAGER_EMAIL);
    const hrHeadId = await membershipByEmail(HR_HEAD_EMAIL);
    if (!panelId || !hiringManagerId || !hrHeadId) {
      console.error(
        `Missing a required membership (panel1/hiringmanager1/hrhead1) in ${TENANT_SLUG}. ` +
          `Run pnpm db:seed:test-users first.`,
      );
      process.exit(2);
    }

    // ── SEED-02 helper: (re)seed interview_plans for a requisition ──
    // Mirrors upsertInterviewPlan's replace-set: delete every plan for the req,
    // then insert the ordered rounds. default_panel_membership_ids seeded with
    // panel1 (advisory hint only). Idempotent.
    async function seedInterviewPlans(
      reqId: string,
      rounds: PlanRound[] = ENGINEERING_ROUNDS,
    ): Promise<void> {
      await poolSql`DELETE FROM public.interview_plans WHERE tenant_id = ${tid} AND requisition_id = ${reqId}`;
      for (const r of rounds) {
        await poolSql`
          INSERT INTO public.interview_plans
            (tenant_id, requisition_id, round_number, round_name, duration_minutes,
             mode, scorecard_template, competency_focus, default_panel_membership_ids)
          VALUES (${tid}, ${reqId}, ${r.round}, ${r.name}, ${r.duration},
                  ${r.mode}, ${r.template}, ${JSON.stringify(r.competencies)}::jsonb,
                  ARRAY[${panelId}]::uuid[])
        `;
      }
    }

    // ── SEED-02 helper: the extra requisitions + approval spine (Problems 5/6) ──
    async function seedExtraRequisitions(): Promise<void> {
      // Shared approval matrix + chain (requisition subject). Deterministic ids,
      // idempotent. resolved_steps: a single hr_head step (mirrors the live shape).
      const resolvedSteps = [
        {
          step_index: 0,
          order_index: 0,
          required: true,
          approver_kind: "role",
          approver_ref: "hr_head",
        },
      ];
      const matrixRules = {
        steps: resolvedSteps,
        note: "SEED-02 demo requisition approval matrix",
      };
      await poolSql`
        INSERT INTO public.approval_matrices
          (id, tenant_id, subject_type, name, rules, effective_from, created_by_membership_id)
        VALUES (${APPROVAL_MATRIX}, ${tid}, 'requisition', 'Requisition approvals (demo)',
                ${JSON.stringify(matrixRules)}::jsonb, now() - interval '60 days', ${hrHeadId})
        ON CONFLICT (id) DO NOTHING
      `;
      await poolSql`
        INSERT INTO public.approval_chains
          (id, tenant_id, matrix_id, matrix_version_snapshot, resolved_steps)
        VALUES (${APPROVAL_CHAIN}, ${tid}, ${APPROVAL_MATRIX},
                ${JSON.stringify(matrixRules)}::jsonb, ${JSON.stringify(resolvedSteps)}::jsonb)
        ON CONFLICT (id) DO NOTHING
      `;

      // Idempotent teardown of the approval spine rows we own (child-first).
      const ownedRequests = [
        APPR_REQ_DATA_PLATFORM,
        APPR_REQ_ENG_MANAGER,
        APPR_REQ_DATA_SCIENTIST,
        APPR_REQ_PRINCIPAL_SRE,
      ];
      await poolSql`DELETE FROM public.approval_decisions WHERE request_id IN ${poolSql(ownedRequests)}`;
      await poolSql`DELETE FROM public.approval_requests WHERE id IN ${poolSql(ownedRequests)}`;

      for (const r of EXTRA_REQS) {
        // position (with location + comp band), jd_version, jd_skills, knockouts.
        await poolSql`
          INSERT INTO public.positions
            (id, tenant_id, business_unit_id, title, location_type, primary_location,
             comp_band_min, comp_band_max, comp_currency, is_active)
          VALUES (${r.positionId}, ${tid}, ${DEMO_BU}, ${r.title}, ${r.locationType},
                  ${r.primaryLocation}, ${r.compMin}::numeric, ${r.compMax}::numeric, 'INR', true)
          ON CONFLICT (id) DO NOTHING
        `;
        await poolSql`
          INSERT INTO public.jd_versions
            (id, tenant_id, position_id, version_number, jd_text, status)
          VALUES (${r.jdId}, ${tid}, ${r.positionId}, 1, ${r.jdText}, 'approved')
          ON CONFLICT (id) DO NOTHING
        `;
        for (const skill of r.skills) {
          await poolSql`
            INSERT INTO public.jd_skills (tenant_id, jd_version_id, skill_name, weight, is_required)
            VALUES (${tid}, ${r.jdId}, ${skill}, 1.00, true)
            ON CONFLICT DO NOTHING
          `;
        }

        // requisition — UPSERT so a re-seed resets the demo status/posting even
        // if a demo run advanced it. posted → public + posted_at; else neither.
        const isPosted = r.posted;
        const postedAtSql = isPosted ? "now() - interval '6 days'" : "NULL";
        await poolSql.unsafe(
          `
          INSERT INTO public.requisitions
            (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
             primary_recruiter_id, hiring_manager_id, status, number_of_openings,
             target_start_date, is_public, public_slug, posted_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                  (now() + interval '45 days')::date, $10, $11, ${postedAtSql})
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            is_public = EXCLUDED.is_public,
            public_slug = EXCLUDED.public_slug,
            posted_at = EXCLUDED.posted_at,
            number_of_openings = EXCLUDED.number_of_openings,
            updated_at = now()
        `,
          [
            r.reqId,
            tid,
            r.positionId,
            r.jdId,
            DEMO_ENVELOPE,
            recruiterId,
            hiringManagerId,
            r.reqStatus,
            r.openings,
            isPosted,
            r.slug,
          ],
        );
        await poolSql`
          INSERT INTO public.requisition_recruiters (tenant_id, requisition_id, recruiter_id)
          VALUES (${tid}, ${r.reqId}, ${recruiterId})
          ON CONFLICT DO NOTHING
        `;
        // knockouts — delete-then-insert (no natural unique key).
        await poolSql`DELETE FROM public.requisition_knockouts WHERE requisition_id = ${r.reqId}`;
        let ko = 0;
        for (const k of r.knockouts) {
          await poolSql`
            INSERT INTO public.requisition_knockouts
              (tenant_id, requisition_id, question_text, type, threshold_value, source, order_index)
            VALUES (${tid}, ${r.reqId}, ${k.question}, ${k.type},
                    ${JSON.stringify(k.threshold)}::jsonb, 'candidate_asserted', ${ko++})
          `;
        }

        // Interview plans on the POSTED reqs (Problem 1 — "each seeded req gains
        // interview plans"). Design req gets the design loop; the rest engineering.
        if (isPosted) {
          await seedInterviewPlans(
            r.reqId,
            r.key === "product-designer" ? DESIGN_ROUNDS : ENGINEERING_ROUNDS,
          );
        }
      }

      // ── approval spine per requisition (Problem 6 queue variety) ──
      // context.requisition_title drives the queue label; bias_scan.flags drive
      // the bias-warning pills. Statuses map (see decideRequisitionApproval):
      //   approved  → request 'approved'  + decision outcome 'approved'
      //   pending   → request 'pending'   (clean = no bias_scan; bias = flags)
      //   sent_back → request 'cancelled' + decision outcome 'abstained'
      const biasFlags = [
        {
          term: "rockstar",
          category: "superlative_pressure",
          severity: "warn",
          suggestion: "Describe the real responsibilities and the impact of the role.",
        },
        {
          term: "ninja",
          category: "superlative_pressure",
          severity: "warn",
          suggestion: "Name the actual skills the role needs.",
        },
      ];
      for (const r of EXTRA_REQS) {
        if (r.approval === "none") continue;
        const isBias = r.approval === "pending_bias";
        const context: Record<string, unknown> = { requisition_title: r.title };
        if (isBias) {
          context.bias_scan = {
            enforcement: "warn",
            blockingCount: 0,
            warningCount: biasFlags.length,
            flags: biasFlags,
          };
        }
        const reqId = r.reqId;
        const requestId =
          r.approval === "approved"
            ? APPR_REQ_DATA_PLATFORM
            : r.approval === "pending_clean"
              ? APPR_REQ_ENG_MANAGER
              : r.approval === "pending_bias"
                ? APPR_REQ_DATA_SCIENTIST
                : APPR_REQ_PRINCIPAL_SRE;

        const status =
          r.approval === "approved"
            ? "approved"
            : r.approval === "sent_back"
              ? "cancelled"
              : "pending";
        const decidedAtSql =
          r.approval === "approved" || r.approval === "sent_back"
            ? "now() - interval '2 days'"
            : "NULL";
        await poolSql.unsafe(
          `
          INSERT INTO public.approval_requests
            (id, tenant_id, chain_id, subject_type, subject_id, status,
             current_step_index, requested_by_membership_id, requested_at, decided_at, context)
          VALUES ($1, $2, $3, 'requisition', $4, $5, 0, $6,
                  now() - interval '5 days', ${decidedAtSql}, $7::jsonb)
        `,
          [requestId, tid, APPROVAL_CHAIN, reqId, status, hiringManagerId, JSON.stringify(context)],
        );

        // decisions for the terminal ones.
        if (r.approval === "approved") {
          await poolSql`
            INSERT INTO public.approval_decisions
              (id, tenant_id, request_id, step_index, outcome, approver_membership_id, decided_at, comment, metadata)
            VALUES (${APPR_DEC_DATA_PLATFORM}, ${tid}, ${requestId}, 0, 'approved', ${hrHeadId},
                    now() - interval '2 days', 'Approved — clear brief and headcount confirmed.',
                    ${JSON.stringify({ decision: "approve" })}::jsonb)
          `;
        } else if (r.approval === "sent_back") {
          await poolSql`
            INSERT INTO public.approval_decisions
              (id, tenant_id, request_id, step_index, outcome, approver_membership_id, decided_at, comment, metadata)
            VALUES (${APPR_DEC_PRINCIPAL_SRE}, ${tid}, ${requestId}, 0, 'abstained', ${hrHeadId},
                    now() - interval '2 days',
                    'Sending back — please add the on-call expectation and confirm the band against the SRE ladder.',
                    ${JSON.stringify({ decision: "send_back" })}::jsonb)
          `;
        }

        // A state transition for realism (queue doesn't read it, but the req
        // detail history does). Delete-then-insert keyed by req for idempotency.
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${reqId}`;
        if (r.approval === "approved") {
          await poolSql.unsafe(
            `INSERT INTO public.requisition_state_transitions
               (tenant_id, requisition_id, from_status, to_status, transitioned_at, transitioned_by)
             VALUES ($1,$2,'draft','pending_approval', now() - interval '5 days', $3),
                    ($1,$2,'pending_approval','approved', now() - interval '2 days', $4),
                    ($1,$2,'approved','posted', now() - interval '1 day', $3)`,
            [tid, reqId, hiringManagerId, hrHeadId],
          );
        } else if (r.approval === "sent_back") {
          await poolSql.unsafe(
            `INSERT INTO public.requisition_state_transitions
               (tenant_id, requisition_id, from_status, to_status, transitioned_at, transitioned_by)
             VALUES ($1,$2,'draft','pending_approval', now() - interval '5 days', $3),
                    ($1,$2,'pending_approval','draft', now() - interval '2 days', $4)`,
            [tid, reqId, hiringManagerId, hrHeadId],
          );
        } else {
          await poolSql.unsafe(
            `INSERT INTO public.requisition_state_transitions
               (tenant_id, requisition_id, from_status, to_status, transitioned_at, transitioned_by)
             VALUES ($1,$2,'draft','pending_approval', now() - interval '5 days', $3)`,
            [tid, reqId, hiringManagerId],
          );
        }
      }
    }

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
            ${DEMO_AGENT_DESCRIPTION},
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

    // ── 4a-bis. SEED-02 Problem 3 — H's second pending approval ──────
    //
    // A SECOND openable approval on the SAME agent for candidate H (Meera Nair),
    // so /approvals shows TWO entries that both open with full detail. Same
    // halted-draft end-state as G; the child-first teardown above (keyed on
    // agent_id = DEMO_AGENT) already wipes these rows on a re-run, so nothing
    // extra to tear down. H therefore no longer relies on a live scanner drain —
    // the demo shows two robust, pre-seeded approvals.
    const hTriggerContext = { application_id: APP_H, trigger: "stage_stale", stage: STALE_STAGE };
    const hTriggerContextJson = JSON.stringify(hTriggerContext);
    const hDraftText =
      `Hi Meera,\n\n` +
      `I wanted to check in on your application for the Senior Backend Engineer ` +
      `role at ${companyName}. You've been at the technical interview stage for ` +
      `just under a week, and I didn't want you waiting without an update while we ` +
      `coordinate the panel.\n\n` +
      `We're keen to keep things moving — I'm lining up interviewer availability ` +
      `and expect to share a slot with you shortly. If anything has changed on ` +
      `your side, or you have any questions, just reply here and I'll come back to ` +
      `you the same day.\n\n` +
      `Thanks for your patience.\n\n` +
      `Warm regards,\nThe Talent Team`;
    const hDraftPayload = {
      draft_text: hDraftText,
      subject: "Update on your application — Senior Backend Engineer",
      application_id: APP_H,
      candidate_id: CAND_H,
      candidate_name: "Meera Nair",
      candidate_email: "meera.nair@example.test",
      position_title: "Senior Backend Engineer",
      company_name: companyName,
      stage: STALE_STAGE,
      days_in_stage: 6,
      template_prompt_id: "follow_up_v1",
      prompt_version: "followup-v1",
      tone: FOLLOWUP_TONE,
    };
    const hDraftPayloadJson = JSON.stringify(hDraftPayload);
    const hRunActionInputJson = JSON.stringify({
      config: {
        template_prompt_id: "follow_up_v1",
        tone: FOLLOWUP_TONE,
        max_tokens: FOLLOWUP_MAX_TOKENS,
      },
      triggerContext: hTriggerContext,
    });
    await poolSql`
    INSERT INTO public.agent_runs
      (id, tenant_id, agent_id, triggered_by, triggered_by_user_id,
       triggered_at, trigger_context, status, cost_micros)
    VALUES (${DEMO_RUN_H}, ${tid}, ${DEMO_AGENT}, 'system', NULL,
            now() - interval '9 minutes', ${hTriggerContextJson}::jsonb,
            'awaiting_approval', ${"3600"}::bigint)
  `;
    await poolSql`
    INSERT INTO public.agent_run_outbox
      (id, tenant_id, agent_id, trigger_context, status,
       enqueued_at, started_at, locked_until, attempt_count)
    VALUES (${DEMO_OUTBOX_H}, ${tid}, ${DEMO_AGENT}, ${hTriggerContextJson}::jsonb,
            'awaiting_approval', now() - interval '9 minutes',
            now() - interval '9 minutes', now() - interval '6 minutes', 1)
  `;
    await poolSql`
    INSERT INTO public.agent_run_actions
      (id, tenant_id, run_id, action_id, action_order, status,
       started_at, input, output, approval_request_id)
    VALUES (${DEMO_RUN_ACTION_H}, ${tid}, ${DEMO_RUN_H}, ${DEMO_DRAFT_ACTION}, 1,
            'awaiting_approval', now() - interval '9 minutes',
            ${hRunActionInputJson}::jsonb, ${hDraftPayloadJson}::jsonb,
            ${DEMO_APPROVAL_H})
  `;
    await poolSql`
    INSERT INTO public.agent_approval_requests
      (id, tenant_id, run_id, run_action_id, agent_id, proposed_at,
       proposed_action_summary, proposed_action_payload, approver_role,
       status, ttl_at)
    VALUES (${DEMO_APPROVAL_H}, ${tid}, ${DEMO_RUN_H}, ${DEMO_RUN_ACTION_H}, ${DEMO_AGENT},
            now() - interval '9 minutes', 'draft_message requires approval',
            ${hDraftPayloadJson}::jsonb, 'owning_recruiter', 'pending', NULL)
  `;

    // ── 4c. SEED-02 Problem 1 — interview plans + seeded interviews ──
    //
    // Interview PLANS (the round loop) for the demo requisition, then three
    // INTERVIEWS that render on: recruiter /interviews (variety: 2 scheduled +
    // 1 completed), panel1's "My interviews" (panel1 is a panelist on all three),
    // and the recruiter decision summary (the completed round carries a submitted
    // panel1 scorecard). Idempotent: delete-by-scope then reinsert so timestamps
    // refresh. Deleting an interview CASCADES its panelists + feedback.
    await seedInterviewPlans(DEMO_REQ);
    // Clear any prior seeded interviews on these three applications (cascades
    // panelists + feedback) so re-runs refresh cleanly.
    for (const appId of [APP_C, APP_D, APP_E]) {
      await poolSql`DELETE FROM public.interviews WHERE tenant_id = ${tid} AND application_id = ${appId}`;
    }

    // (1) Karthik (D) — round 1, upcoming, NOT confirmed → "Pending" chip.
    await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name,
       status, scorecard_template, scheduled_start, scheduled_end, duration_minutes,
       mode, meeting_url, candidate_confirmed_at, created_by_membership_id)
    VALUES (${IV_D_SCHEDULED}, ${tid}, ${APP_D}, ${DEMO_REQ}, 1, 'Technical deep-dive',
            'scheduled', 'technical', now() + interval '2 days',
            now() + interval '2 days' + interval '60 minutes', 60,
            'video', 'https://meet.example.test/hireops-demo-d', NULL, ${recruiterId})
  `;
    await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tid}, ${IV_D_SCHEDULED}, ${panelId}, true)
  `;

    // (2) Sneha (C) — round 1, upcoming, candidate-confirmed → "Confirmed" chip.
    await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name,
       status, scorecard_template, scheduled_start, scheduled_end, duration_minutes,
       mode, meeting_url, candidate_confirmed_at, created_by_membership_id)
    VALUES (${IV_C_CONFIRMED}, ${tid}, ${APP_C}, ${DEMO_REQ}, 1, 'Technical deep-dive',
            'scheduled', 'technical', now() + interval '3 days',
            now() + interval '3 days' + interval '60 minutes', 60,
            'video', 'https://meet.example.test/hireops-demo-c',
            now() - interval '1 day', ${recruiterId})
  `;
    await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tid}, ${IV_C_CONFIRMED}, ${panelId}, true)
  `;

    // (3) Priya (E) — round 2, COMPLETED, panel1 is lead with a submitted
    // scorecard (technical template keys) → the recruiter decision summary
    // renders a full roll-up + lead recommendation.
    await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name,
       status, scorecard_template, scheduled_start, scheduled_end, duration_minutes,
       mode, meeting_url, candidate_confirmed_at, created_by_membership_id)
    VALUES (${IV_E_COMPLETED}, ${tid}, ${APP_E}, ${DEMO_REQ}, 2, 'System design',
            'completed', 'technical', now() - interval '5 days',
            now() - interval '5 days' + interval '60 minutes', 60,
            'video', 'https://meet.example.test/hireops-demo-e',
            now() - interval '6 days', ${recruiterId})
  `;
    await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tid}, ${IV_E_COMPLETED}, ${panelId}, true)
  `;
    await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, strengths, concerns,
       notes, recommendation, submitted_at)
    VALUES (${tid}, ${IV_E_COMPLETED}, ${panelId},
            ${JSON.stringify({ problem_solving: 5, technical_depth: 5, code_quality: 4, system_design: 4, communication: 5 })}::jsonb,
            'Excellent systems thinking; walked through the idempotency + sharding trade-offs unprompted. Clear communicator.',
            'Slightly light on frontend depth, but not needed for this role.',
            'Strong hire — would happily have on the platform team.',
            'strong_yes', now() - interval '4 days')
  `;

    // ── 4c. HROPS-01 HR Ops cases — two candidates AT hr_round ──────────
    //
    // The HR-Ops workspace (/hr-cases, /hr-rounds) needs live cases sitting
    // AT hr_round with real interview feedback so the surfaces demo well.
    // Two dedicated candidates against DEMO_REQ, each with a completed tech
    // round (submitted feedback) + an HR round:
    //   • Aisha  — HR round SCHEDULED, NO assessment  → "HR round pending".
    //   • Vikram — HR round COMPLETED + a saved 'proceed' assessment (the
    //     deterministic gate satisfied; shows a rating in /hr-rounds).
    // Self-cleaning by deterministic id (a5c1–a5cb; deleting the application
    // cascades interviews + feedback + assessment). application_state_transitions
    // do NOT cascade, so clear them first — same idiom the onboarding block uses.
    {
      const HR_PERSON1 = "00000000-0000-4000-8000-00000000a5c1";
      const HR_CAND1 = "00000000-0000-4000-8000-00000000a5c2";
      const HR_APP1 = "00000000-0000-4000-8000-00000000a5c3";
      const HR_PERSON2 = "00000000-0000-4000-8000-00000000a5c4";
      const HR_CAND2 = "00000000-0000-4000-8000-00000000a5c5";
      const HR_APP2 = "00000000-0000-4000-8000-00000000a5c6";
      const HR_IV1_TECH = "00000000-0000-4000-8000-00000000a5c7";
      const HR_IV1_HR = "00000000-0000-4000-8000-00000000a5c8";
      const HR_IV2_TECH = "00000000-0000-4000-8000-00000000a5c9";
      const HR_IV2_HR = "00000000-0000-4000-8000-00000000a5ca";
      const HR_ASSESS2 = "00000000-0000-4000-8000-00000000a5cb";
      const hrApps = [HR_APP1, HR_APP2];

      for (const id of hrApps) {
        await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${id}`;
        await poolSql`DELETE FROM public.applications WHERE id = ${id}`;
      }
      await poolSql`DELETE FROM public.candidates WHERE id IN (${HR_CAND1}, ${HR_CAND2})`;
      await poolSql`DELETE FROM public.persons WHERE id IN (${HR_PERSON1}, ${HR_PERSON2})`;

      await poolSql`
      INSERT INTO public.persons
        (id, tenant_id, full_name, email_primary, email_normalised, phone_primary,
         phone_normalised, location_country, location_city, linkedin_url)
      VALUES
        (${HR_PERSON1}, ${tid}, 'Aisha Khan', 'aisha.khan.hrops@example.test',
         'aisha.khan.hrops@example.test', '+919812300021', '919812300021', 'IN', 'Bengaluru',
         'https://www.linkedin.com/in/aisha-khan-demo'),
        (${HR_PERSON2}, ${tid}, 'Vikram Rao', 'vikram.rao.hrops@example.test',
         'vikram.rao.hrops@example.test', '+919812300022', '919812300022', 'IN', 'Pune',
         'https://www.linkedin.com/in/vikram-rao-demo')`;
      await poolSql`
      INSERT INTO public.candidates
        (id, tenant_id, person_id, source, consent_version, parsed_skills, years_of_experience)
      VALUES
        (${HR_CAND1}, ${tid}, ${HR_PERSON1}, 'referral', 'v1',
         ${JSON.stringify(["Java", "Spring Boot", "Kafka", "PostgreSQL"])}::jsonb, 7.0),
        (${HR_CAND2}, ${tid}, ${HR_PERSON2}, 'job_board', 'v1',
         ${JSON.stringify(["Go", "Kubernetes", "AWS", "gRPC"])}::jsonb, 9.0)`;
      await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at,
         ai_score, ai_scored_at, ai_score_explanation, assigned_recruiter_membership_id,
         created_at, knockout_passed)
      VALUES
        (${HR_APP1}, ${tid}, ${HR_CAND1}, ${DEMO_REQ}, 'referral', 'hr_round',
         now() - interval '2 days', 86, now() - interval '9 days',
         ${JSON.stringify({
           top_factors: [
             { factor: "skills_match", score: 0.9, note: "All required skills" },
             { factor: "interview_signal", score: 0.88, note: "Strong technical round" },
           ],
           caveats: [],
           scored_at: new Date().toISOString(),
           scored_by: "simulated",
         })}::jsonb,
         ${recruiterId}, now() - interval '11 days', true),
        (${HR_APP2}, ${tid}, ${HR_CAND2}, ${DEMO_REQ}, 'job_board', 'hr_round',
         now() - interval '1 day', 90, now() - interval '12 days',
         ${JSON.stringify({
           top_factors: [
             { factor: "skills_match", score: 0.92, note: "Distributed-systems depth" },
             { factor: "experience_level", score: 0.9, note: "9 years — strong L6" },
           ],
           caveats: [],
           scored_at: new Date().toISOString(),
           scored_by: "simulated",
         })}::jsonb,
         ${recruiterId}, now() - interval '14 days', true)`;
      // Transitions so the pipeline reads honestly (received → … → hr_round).
      await poolSql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, actor_membership_id, transitioned_at)
      VALUES
        (${tid}, ${HR_APP1}, NULL, 'application_received', ${recruiterId}, now() - interval '11 days'),
        (${tid}, ${HR_APP1}, 'application_received', 'recruiter_review', ${recruiterId}, now() - interval '10 days'),
        (${tid}, ${HR_APP1}, 'recruiter_review', 'tech_interview', ${recruiterId}, now() - interval '6 days'),
        (${tid}, ${HR_APP1}, 'tech_interview', 'hr_round', ${recruiterId}, now() - interval '2 days'),
        (${tid}, ${HR_APP2}, NULL, 'application_received', ${recruiterId}, now() - interval '14 days'),
        (${tid}, ${HR_APP2}, 'application_received', 'recruiter_review', ${recruiterId}, now() - interval '13 days'),
        (${tid}, ${HR_APP2}, 'recruiter_review', 'tech_interview', ${recruiterId}, now() - interval '7 days'),
        (${tid}, ${HR_APP2}, 'tech_interview', 'hr_round', ${recruiterId}, now() - interval '1 day')`;
      // Completed tech rounds + submitted feedback (recommendation, NO exposure
      // of scores to HR — the surface hides them).
      await poolSql`
      INSERT INTO public.interviews
        (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
         scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode,
         candidate_confirmed_at, created_by_membership_id)
      VALUES
        (${HR_IV1_TECH}, ${tid}, ${HR_APP1}, ${DEMO_REQ}, 1, 'Technical deep-dive', 'completed',
         'technical', now() - interval '5 days', now() - interval '5 days' + interval '60 minutes', 60,
         'video', now() - interval '6 days', ${recruiterId}),
        (${HR_IV2_TECH}, ${tid}, ${HR_APP2}, ${DEMO_REQ}, 1, 'Technical deep-dive', 'completed',
         'technical', now() - interval '6 days', now() - interval '6 days' + interval '60 minutes', 60,
         'video', now() - interval '7 days', ${recruiterId})`;
      await poolSql`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${tid}, ${HR_IV1_TECH}, ${panelId}, true), (${tid}, ${HR_IV2_TECH}, ${panelId}, true)`;
      await poolSql`
      INSERT INTO public.interview_feedback
        (tenant_id, interview_id, membership_id, scorecard, strengths, concerns, notes,
         recommendation, submitted_at)
      VALUES
        (${tid}, ${HR_IV1_TECH}, ${panelId},
         ${JSON.stringify({ problem_solving: 4, technical_depth: 4, communication: 5 })}::jsonb,
         'Solid fundamentals; clean approach to the concurrency problem.',
         'Wanted a little more depth on failure modes.',
         'Good hire for the platform team.', 'yes', now() - interval '5 days'),
        (${tid}, ${HR_IV2_TECH}, ${panelId},
         ${JSON.stringify({ problem_solving: 5, technical_depth: 5, communication: 4 })}::jsonb,
         'Exceptional systems design; reasoned about trade-offs unprompted.',
         'None material.',
         'Strong hire.', 'strong_yes', now() - interval '6 days')`;
      // HR rounds: Aisha SCHEDULED (upcoming), Vikram COMPLETED.
      await poolSql`
      INSERT INTO public.interviews
        (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
         scorecard_template, scheduled_start, scheduled_end, duration_minutes, mode,
         candidate_confirmed_at, created_by_membership_id)
      VALUES
        (${HR_IV1_HR}, ${tid}, ${HR_APP1}, ${DEMO_REQ}, 2, 'HR round', 'scheduled',
         'hr', now() + interval '2 days', now() + interval '2 days' + interval '45 minutes', 45,
         'phone', now() - interval '1 day', ${recruiterId}),
        (${HR_IV2_HR}, ${tid}, ${HR_APP2}, ${DEMO_REQ}, 2, 'HR round', 'completed',
         'hr', now() - interval '1 day', now() - interval '1 day' + interval '45 minutes', 45,
         'phone', now() - interval '2 days', ${recruiterId})`;
      await poolSql`
      INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
      VALUES (${tid}, ${HR_IV1_HR}, ${hrHeadId}, true), (${tid}, ${HR_IV2_HR}, ${hrHeadId}, true)`;
      // Vikram's saved HR-round assessment (proceed) — the gate satisfied.
      await poolSql`
      INSERT INTO public.hr_round_assessments
        (id, tenant_id, application_id, motivation_discussed, salary_expectation_discussed,
         culture_fit_assessed, work_authorization_verified, notice_period_confirmed,
         relocation_willingness, notes, rating, recommendation, completed_by_membership_id,
         created_at, updated_at)
      VALUES
        (${HR_ASSESS2}, ${tid}, ${HR_APP2}, true, true, true, true, true, false,
         'Motivated by the platform charter; comp expectation within band; 30-day notice; open to hybrid Pune.',
         4, 'proceed', ${hrHeadId}, now() - interval '1 day', now() - interval '1 day')`;
    }

    // ── 4d. SEED-02 Problems 5/6 — extra requisitions + approval spine ──
    await seedExtraRequisitions();

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
      // The offboard-demo completed case also writes a terminate row into
      // workday_sync_outbox with subject_application_id set (RESTRICT) —
      // clear outbox rows for this application before the delete too.
      await poolSql`DELETE FROM public.workday_sync_outbox WHERE subject_application_id = ${id}`;
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

    // ── 4e. SEED-02 Problem 4 — seeded onboarding documents ─────────
    //
    // Two uploaded documents (one VERIFIED, one PENDING review) on Kavya Reddy's
    // pre_boarding case (…a562) so the document section is demoable WITHOUT a live
    // upload (the recruiter /onboarding case view renders them). Priya stays
    // pre-accept with a calm empty state (no seeded case) — the "failed to fetch"
    // she saw on staging was a build-time env issue (NEXT_PUBLIC_API_BASE_URL),
    // not seed data. The case (…a562) is delete-recreated above, so its documents
    // cascade away each run; we insert fresh with deterministic ids. document_type
    // references are resolved from document_types (IN, pre_boarding) so they match
    // the checklist. storage_ref is a placeholder pointer (no blob needed to show
    // the row — download would 404, which is fine for a seeded demo artefact).
    const kavyaCaseId = onbAt(ONB_CASE_IDS, 1); // Kavya Reddy — pre_boarding, IN
    const docTypes = await poolSql<{ id: string; name: string }[]>`
      SELECT id::text AS id, name FROM public.document_types
      WHERE required_for_lifecycle_stage = 'pre_boarding'
        AND (geography_code IS NULL OR geography_code = 'IN')
      ORDER BY code
      LIMIT 2
    `;
    const t0 = docTypes[0];
    const t1 = docTypes[1];
    if (t0 && t1) {
      await poolSql`
        INSERT INTO public.onboarding_documents
          (id, tenant_id, case_id, document_type_id, storage_ref, file_name, mime_type,
           size_bytes, verification_status, verified_by_membership_id, verified_at, uploaded_at)
        VALUES (${ONB_DOC_VERIFIED}, ${tid}, ${kavyaCaseId}, ${t0.id},
                'seed://onboarding/kavya/verified.pdf', ${`${t0.name}.pdf`}, 'application/pdf',
                ${"184320"}::bigint, 'verified', ${recruiterId}, now() - interval '2 days',
                now() - interval '3 days')
        ON CONFLICT (id) DO NOTHING
      `;
      await poolSql`
        INSERT INTO public.onboarding_documents
          (id, tenant_id, case_id, document_type_id, storage_ref, file_name, mime_type,
           size_bytes, verification_status, uploaded_at)
        VALUES (${ONB_DOC_PENDING}, ${tid}, ${kavyaCaseId}, ${t1.id},
                'seed://onboarding/kavya/pending.pdf', ${`${t1.name}.pdf`}, 'application/pdf',
                ${"201728"}::bigint, 'pending', now() - interval '1 day')
        ON CONFLICT (id) DO NOTHING
      `;
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
      "  H. Meera Nair          tech_interview         score=83   6d in stage  (SEED-02 2nd pending approval)",
    );
    console.log("");
    console.log("SEED-02 follow-ups wedge:");
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
      `  Approvals: 2 pending, owning_recruiter — both OPEN with full detail at /approvals`,
    );
    console.log(`             ${DEMO_APPROVAL_G}  Rohan Desai (G)`);
    console.log(`             ${DEMO_APPROVAL_H}  Meera Nair (H)`);
    console.log("");
    console.log("SEED-02 interviews on the demo requisition (Problem 1):");
    console.log(
      `  Karthik (D)  round 1 "Technical deep-dive"  scheduled (+2d)  panel1  · Pending confirm`,
    );
    console.log(
      `  Sneha   (C)  round 1 "Technical deep-dive"  scheduled (+3d)  panel1  · Confirmed`,
    );
    console.log(
      `  Priya   (E)  round 2 "System design"        completed        panel1  · scorecard strong_yes`,
    );
    console.log(
      `  → panel1@ My interviews shows 3; recruiter /interviews shows 2 scheduled + 1 completed.`,
    );
    console.log("");
    console.log("SEED-02 extra requisitions (Problems 5/6):");
    for (const r of EXTRA_REQS) {
      const appr = r.approval === "none" ? "" : ` · approval=${r.approval}`;
      console.log(`  ${r.title.padEnd(38)} ${r.reqStatus.padEnd(16)}${appr}`);
    }
    console.log(
      `  HR-head /requisition-approvals queue: 1 approved · 1 pending clean · 1 pending+bias · 1 sent-back`,
    );
    console.log("");
    console.log(`ONBOARD-04 onboarding cases (${ONB_CASE_SPECS.length}) at /onboarding:`);
    for (const spec of ONB_CASE_SPECS) {
      console.log(`  ${spec.fullName.padEnd(20)} ${spec.blurb}`);
    }
    console.log(
      `  buddy/manager assignees: recruiter1${hrOpsId ? " + hr_ops1" : ""}${adminId ? " + admin1" : ""}`,
    );
    console.log(`  Kavya Reddy's case carries 2 seeded documents (1 verified, 1 pending review).`);
    console.log("");
    console.log("Candidate E offer-accept URL (single-use, expires in 7 days):");
    console.log(`  ${acceptUrl}`);
    console.log("");
    console.log("Public apply URLs (CRS-01, anyone can submit — each resolves 200):");
    console.log(`  ${PORTAL_BASE}/t/${TENANT_SLUG}/apply/gcc-blr-senior-backend`);
    for (const r of EXTRA_REQS) {
      if (r.posted) console.log(`  ${PORTAL_BASE}/t/${TENANT_SLUG}/apply/${r.slug}`);
    }
    console.log("");
    console.log("Candidate F is pending real AI scoring (ai_score_outbox row).");
    console.log("Boot apps/workers with ANTHROPIC_API_KEY set to drain via the live");
    console.log("provider; otherwise the LocalAIClient fixture corpus handles it in");
    console.log("test mode.");
    console.log("");
    console.log("Login as recruiter1@kyndryl-poc.test / TestPassword123! to walk the lifecycle.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
