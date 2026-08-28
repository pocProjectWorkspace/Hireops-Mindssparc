/**
 * Analytics demo seed — populates every card on /insights, /hr-analytics and
 * /metrics with a realistic, tenant-scoped cohort for the demo recording.
 *
 * WHY THIS EXISTS. Before this seed the three analytics surfaces render mostly
 * empty, for reasons that are structural rather than cosmetic:
 *
 *   1. /insights scopes to "my requisitions" (resolveMyRequisitionScope) — reqs
 *      where hiring_manager_id = your membership, or ALL reqs for an admin.
 *      Every pre-existing application sat on ONE req whose HM is recruiter1,
 *      and `recruiter` isn't even in HM_INSIGHTS_ROLES. The reqs
 *      hiringmanager1 owns had zero applications.
 *   2. `offers` was EMPTY tenant-wide, so the Metrics offer funnel, the
 *      HR-analytics offer-acceptance pie + offer-vs-band chart, and the
 *      Insights offer-accept-rate tile were all zero by construction.
 *   3. The pre-existing hires had `created_at` equal to their offer_accepted
 *      transition and only one transition row each, so time-to-hire computed
 *      0 days and `timeInStage` (which needs consecutive transition pairs via
 *      LEAD) had nothing to pair.
 *   4. No requisition was in status 'filled', so demand-by-dept's filled
 *      series was flat zero.
 *   5. Skill gap reads `parsed_skills.skills` as a STRING ARRAY. Neither
 *      pre-existing parsed_skills shape matched (one was a bare array, one
 *      nested `skills` as an object of categories), so every candidate read as
 *      missing every skill — a uniform 100% gap.
 *
 * This seed fixes all five for a 48-candidate cohort across four requisitions.
 * It does NOT seed AI spend: ai_usage_logs already carries real rows in the
 * trailing 14-day window that the Metrics spend chart reads.
 *
 * SAFETY. This writes to the SHARED staging database.
 *   - It refuses to run unless the tenant slug is `kyndryl-poc`.
 *   - Every row it creates carries the reserved UUID prefix `0000ad00-`, so
 *     `--undo` removes precisely what it added and nothing else.
 *   - It is IDEMPOTENT: content rows upsert on their stable id; transitions,
 *     interviews and feedback are delete-then-reinsert so their timestamps
 *     re-anchor to the run time (the demo always looks current).
 *   - Dates are all computed RELATIVE to now() from a fixed offset table, so
 *     there are no hardcoded calendar dates to rot.
 *
 * It also makes a small number of UPDATEs to PRE-EXISTING rows (these are the
 * only writes `--undo` cannot reverse; they are listed here so the blast radius
 * is legible):
 *   - hiring_manager_id -> hiringmanager1 on the four cohort reqs, so /insights
 *     is non-empty for the hiring-manager persona as well as for admin.
 *   - number_of_openings on the cohort reqs, so fill-rate is a sane percentage.
 *   - requisitions.status -> 'filled' on Data Engineer and 'posted' on Principal
 *     AI Architect (it shipped as 'draft'), for demand-by-dept.
 *   - The Principal AI Architect position: comp band + currency, and the title
 *     typo "Principal AI Archtect" -> "Principal AI Architect".
 *   - The business unit typo "GCC - Hyerabad" -> "GCC - Hyderabad".
 *   - created_at on the six PRE-EXISTING hires, which each equalled their own
 *     offer_accepted transition and so contributed a 0-day time-to-hire to
 *     admin's /insights rollup. Guarded so re-runs don't re-back-date.
 *
 * Run:   pnpm db:seed:analytics-demo
 * Undo:  pnpm db:seed:analytics-demo -- --undo
 *
 * Prerequisite: pnpm db:seed:test-users (memberships referenced below).
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

/** Reserved id prefix for every row this seed owns — the undo key. */
const ID_PREFIX = "0000ad00";

/** Row-kind discriminators, so ids are stable and collision-free per table. */
const KIND = {
  person: 0x01,
  candidate: 0x02,
  application: 0x03,
  transition: 0x04,
  offer: 0x05,
  interview: 0x06,
  feedback: 0x07,
  jdSkill: 0x08,
  panelist: 0x09,
} as const;

/** Deterministic UUID in the reserved namespace: 0000ad00-...-<kind><n>. */
function mkId(kind: number, n: number): string {
  const tail = kind.toString(16).padStart(2, "0") + n.toString(16).padStart(10, "0");
  return `${ID_PREFIX}-0000-4000-8000-${tail}`;
}

/** Wrapping array index that satisfies noUncheckedIndexedAccess. Every pool in
 * this file is a non-empty literal, so the throw is unreachable in practice. */
function pick<T>(pool: readonly T[], i: number): T {
  if (pool.length === 0) throw new Error("pick() on an empty pool");
  const v = pool[((i % pool.length) + pool.length) % pool.length];
  if (v === undefined) throw new Error("pick() produced undefined");
  return v;
}

// ── memberships (from db:seed:test-users) ────────────────────────────────────
//
// RESOLVED AT RUNTIME (SOLENIS-MAP). These were hardcoded uuids from the old
// staging database, which do not exist on any other Supabase project — the seed
// died on the first FK. The shape is unchanged so every `MEMBER.recruiter` call
// site below still reads the same; only the source of the ids moved.
const MEMBER_EMAILS = {
  admin: "admin1@mindssparc.com",
  hiringManager: "hiringmanager1@mindssparc.com",
  hrOps: "hr_ops1@mindssparc.com",
  panel: "panel1@mindssparc.com",
  recruiter: "recruiter1@mindssparc.com",
} as const;

type MemberKey = keyof typeof MEMBER_EMAILS;

const MEMBER: Record<MemberKey, string> = {
  admin: "",
  hiringManager: "",
  hrOps: "",
  panel: "",
  recruiter: "",
};

/** The Solenis GBS India business unit (seed-solenis-demo). The typo fix-up
 * below is guarded on the old "GCC - Hyerabad" name, so it is a no-op here. */
const HYDERABAD_BU = "00000000-0000-4000-9000-010000000001";

type Stage =
  | "application_received"
  | "ai_screening"
  | "recruiter_review"
  | "shortlisted"
  | "tech_interview"
  | "hr_round"
  | "offer_drafted"
  | "offer_accepted"
  | "offer_declined"
  | "withdrawn"
  | "recruiter_rejected";

/** The happy path. Terminals branch off it (see chainFor). */
const PATH: Stage[] = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

/** Days between consecutive PATH stages. Sums to 46 — a credible time-to-hire. */
const GAP_DAYS = [1, 2, 5, 9, 11, 10, 8];

/** Where each terminal branches off the path, and how long after. */
const TERMINAL_BRANCH: Record<string, { after: Stage; days: number }> = {
  offer_declined: { after: "offer_drafted", days: 6 },
  withdrawn: { after: "tech_interview", days: 4 },
  recruiter_rejected: { after: "recruiter_review", days: 2 },
};

interface Step {
  stage: Stage;
  dayOffset: number;
}

/**
 * The dated transition chain for an application ending at `target`, as day
 * offsets from the application's created_at. `jitter` perturbs the final hop so
 * time-to-hire has spread instead of collapsing to one value.
 */
function chainFor(target: Stage, jitter: number): Step[] {
  const branch = TERMINAL_BRANCH[target];
  const endStage = branch ? branch.after : target;
  const idx = PATH.indexOf(endStage);
  if (idx < 0) throw new Error(`unroutable stage: ${target}`);

  const steps: Step[] = [];
  let day = 0;
  for (let i = 0; i <= idx; i++) {
    if (i > 0) day += pick(GAP_DAYS, i - 1);
    steps.push({ stage: pick(PATH, i), dayOffset: day });
  }
  // Jitter the last hop of the happy path so hires don't all take 46 days.
  const last = steps[steps.length - 1];
  if (!branch && last && steps.length > 1) last.dayOffset += jitter;
  // The terminal hop must land AFTER the stage it branches off, or the chain
  // emits an out-of-order transition and Metrics' time-in-stage (a LEAD over
  // consecutive pairs) computes a negative duration. Short branches — e.g.
  // recruiter_rejected at +2d — are within reach of the -3 end of the jitter.
  if (branch) steps.push({ stage: target, dayOffset: day + Math.max(1, branch.days + jitter) });
  return steps;
}

/** How long ago (in days) the LAST transition happened. Drives stage_entered_at,
 * which in turn drives the SLA tiles + the bottleneck note. Mixed on purpose so
 * some stages breach their target and some don't. */
const RECENCY_DAYS = [0.1, 0.4, 1.2, 2.5, 4, 6, 9, 13, 18, 24, 31, 38];

/**
 * ai_screening is the one stage that gets its own (minutes-old) recency.
 *
 * Its SLA target is ONE HOUR — the tightest in SLA_THRESHOLDS_HOURS, because
 * the scoring is machine work. Drawing from RECENCY_DAYS would park candidates
 * there for days, so the Insights bottleneck note would open with "AI screening
 * is 300h past its 1h SLA target" — the product's own headline capability
 * reading as the single worst stage in the pipeline. These keep it comfortably
 * green and leave the (deliberate) breaches to the human stages.
 */
const AI_SCREENING_RECENCY_DAYS = [0.012, 0.028];

/** AI scores by stage — later stages score higher, with spread inside each
 * band so both histograms (Insights' 4 buckets, Metrics' 10 bins) fill. */
const SCORES: Record<Stage, number[]> = {
  application_received: [52, 61],
  ai_screening: [48],
  recruiter_review: [66, 71, 58],
  shortlisted: [78, 82],
  tech_interview: [84, 88, 76],
  hr_round: [86, 91, 79],
  offer_drafted: [92, 89, 94],
  offer_accepted: [95, 93, 90],
  offer_declined: [87],
  withdrawn: [74],
  recruiter_rejected: [34, 41, 22],
};

const SOURCES = [
  "career_site",
  "referral",
  "job_board",
  "partner_empanelled",
  "talent_pool",
  "agency_search",
  "whatsapp",
  "partner_adhoc",
];

const FIRST_NAMES = [
  "Ananya",
  "Rohan",
  "Priya",
  "Vikram",
  "Meera",
  "Arjun",
  "Kavya",
  "Siddharth",
  "Divya",
  "Karthik",
  "Neha",
  "Aditya",
  "Shreya",
  "Rahul",
  "Ishita",
  "Nikhil",
  "Pooja",
  "Varun",
  "Sneha",
  "Aakash",
  "Tanvi",
  "Manish",
  "Ritika",
  "Gaurav",
  "Lakshmi",
  "Sanjay",
  "Aisha",
  "Harsh",
  "Nandini",
  "Rajat",
  "Swati",
  "Deepak",
  "Anjali",
  "Vivek",
  "Preeti",
  "Sameer",
  "Ruchi",
  "Abhishek",
  "Madhuri",
  "Kunal",
  "Sunita",
  "Naveen",
  "Chitra",
  "Amit",
  "Rekha",
  "Prakash",
  "Vidya",
  "Sunil",
];

const LAST_NAMES = [
  "Sharma",
  "Iyer",
  "Nair",
  "Reddy",
  "Menon",
  "Kulkarni",
  "Desai",
  "Rao",
  "Patel",
  "Krishnan",
  "Banerjee",
  "Chatterjee",
  "Gupta",
  "Malhotra",
  "Joshi",
  "Bhat",
  "Pillai",
  "Saxena",
  "Verma",
  "Kapoor",
  "Sinha",
  "Mehta",
  "Chopra",
  "Agarwal",
  "Subramanian",
  "Naidu",
  "Dutta",
  "Bose",
  "Ghosh",
  "Trivedi",
  "Shetty",
  "Prabhu",
  "Hegde",
  "Bhattacharya",
  "Mukherjee",
  "Rangan",
  "Varma",
  "Chandra",
  "Kaur",
  "Sethi",
  "Dubey",
  "Rastogi",
  "Anand",
  "Bajaj",
  "Tiwari",
  "Mishra",
  "Pandey",
  "Shukla",
];

interface ReqSpec {
  key: string;
  requisitionId: string;
  positionId: string;
  jdVersionId: string;
  roleTitle: string;
  /** Openings to set, so fill rate reads as a sane percentage. */
  openings: number;
  /** Requisition status to force, if any. */
  forceStatus?: string;
  /** Offer base salary in MAJOR rupees (converted to paise on write). */
  offerBaseRupees: number;
  /** The position's comp_band_max in MAJOR rupees. Drives the deliberately
   * over-band offers (see OVER_BAND) that light up the comp desk's
   * "Need approval" posture — computeOfferApprovalStatus keys off base > max. */
  bandMaxRupees: number;
  location: string;
  /**
   * Ordered JD skills. Candidates take a prefix of this list, so the skill-gap
   * bars differ per skill. These MIRROR the requisition's real `jd_skills`
   * rows — the gap chart compares candidate parsed_skills against the JD, so a
   * pool drawn from anywhere else reads as a flat 100% wall on every bar.
   * Only `seedJdSkills` reqs get these written to jd_skills; the rest already
   * have them.
   */
  skills: { name: string; required: boolean }[];
  /** Write `skills` into jd_skills (the hero req had none of its own). */
  seedJdSkills?: boolean;
  /** Stage -> how many candidates sit there. */
  cohort: Partial<Record<Stage, number>>;
}

/**
 * SOLENIS-MAP: the cohort now sits on FOUR Solenis GBS requisitions created by
 * seed-solenis-demo (`00000000-0000-4000-9000-…`). The old specs pointed at
 * hardcoded old-staging uuids that do not exist on this database, so the seed
 * could not run at all. Only the spec constants moved — ids, titles, comp and
 * skills; the cohort/date/score machinery below is untouched.
 *
 * `openings` deliberately MATCHES seed-solenis-demo's `openings` for the same
 * requisition, so whichever seed runs last, fill rate (hires/openings) stays
 * sane instead of flipping between 100% and 200%.
 */
const REQS: ReqSpec[] = [
  {
    // The hero req — the SDL / Head role from Solenis's own JD pack.
    key: "sdl-head-automation",
    requisitionId: "00000000-0000-4000-9000-120000000006",
    positionId: "", // resolved at runtime from the requisition
    jdVersionId: "00000000-0000-4000-9000-110000000006",
    roleTitle: "SDL / Head – Automation and Productivity (GBS)",
    openings: 1,
    forceStatus: "posted",
    // Leadership band: ₹45–65 LPA (MAJOR rupees).
    offerBaseRupees: 5_500_000,
    bandMaxRupees: 6_500_000,
    location: "Hyderabad",
    // seed-solenis-demo already writes this JD's skills, so do NOT write them
    // again — jd_skills has no natural unique key and would duplicate the bars
    // on the skill-gap panel. The list below mirrors those rows exactly, which
    // is what the candidate skill pool is drawn from.
    seedJdSkills: false,
    skills: [
      { name: "Celonis / Process Mining", required: true },
      { name: "RPA", required: true },
      { name: "AI / GenAI Adoption", required: true },
      { name: "Automation Governance", required: true },
      { name: "SAP", required: true },
      { name: "Value Realisation", required: true },
    ],
    cohort: {
      application_received: 2,
      ai_screening: 1,
      recruiter_review: 2,
      shortlisted: 2,
      tech_interview: 3,
      hr_round: 2,
      offer_drafted: 3,
      // 1, not 2: this is a single-headcount leadership role, and fill rate is
      // hires/openings.
      offer_accepted: 1,
      offer_declined: 1,
      withdrawn: 1,
      recruiter_rejected: 1,
    },
  },
  {
    key: "sap-plant-accountant",
    requisitionId: "00000000-0000-4000-9000-120000000003",
    positionId: "",
    jdVersionId: "00000000-0000-4000-9000-110000000003",
    roleTitle: "SAP Plant Accountant",
    openings: 2,
    // Band IN12: ₹12–18 LPA.
    offerBaseRupees: 1_500_000,
    bandMaxRupees: 1_800_000,
    location: "Hyderabad",
    skills: [
      { name: "SAP FI/CO", required: true },
      { name: "Plant Accounting", required: true },
      { name: "Inventory Valuation", required: true },
      { name: "Month-End Close", required: true },
      { name: "IFRS", required: true },
    ],
    cohort: {
      application_received: 1,
      recruiter_review: 2,
      shortlisted: 1,
      tech_interview: 2,
      hr_round: 2,
      offer_drafted: 2,
      offer_accepted: 2,
    },
  },
  {
    key: "tableau-analyst",
    requisitionId: "00000000-0000-4000-9000-120000000004",
    positionId: "",
    jdVersionId: "00000000-0000-4000-9000-110000000004",
    roleTitle: "Tableau Analyst",
    openings: 2,
    // Band IN12: ₹12–18 LPA.
    offerBaseRupees: 1_450_000,
    bandMaxRupees: 1_800_000,
    location: "Hyderabad",
    skills: [
      { name: "Tableau", required: true },
      { name: "SQL", required: true },
      { name: "Data Modelling", required: true },
      { name: "Alteryx", required: true },
      { name: "Power BI", required: true },
    ],
    cohort: {
      application_received: 1,
      ai_screening: 1,
      recruiter_review: 1,
      shortlisted: 1,
      tech_interview: 2,
      hr_round: 1,
      offer_accepted: 2,
      offer_declined: 1,
    },
  },
  {
    key: "non-sap-plant-accountant",
    requisitionId: "00000000-0000-4000-9000-120000000005",
    positionId: "",
    jdVersionId: "00000000-0000-4000-9000-110000000005",
    roleTitle: "Non-SAP Plant Accountant",
    openings: 1,
    // The one CLOSED requisition, so demand-by-department's "filled" series is
    // non-zero. seed-solenis-demo seeds this req as 'filled' too.
    forceStatus: "filled",
    // Band IN12: ₹12–18 LPA.
    offerBaseRupees: 1_400_000,
    bandMaxRupees: 1_800_000,
    location: "Hyderabad",
    skills: [
      { name: "Plant Accounting", required: true },
      { name: "Cost Accounting", required: true },
      { name: "Month-End Close", required: true },
      { name: "Advanced Excel", required: true },
      { name: "Internal Controls", required: true },
    ],
    cohort: {
      hr_round: 1,
      offer_accepted: 1,
      offer_declined: 1,
      withdrawn: 1,
      recruiter_rejected: 2,
    },
  },
];

/**
 * Offers deliberately written ABOVE their position's comp band max, keyed by
 * `${req.key}:${stage}:${k}` (k = index within that req's stage bucket).
 *
 * WHY. /hr-analytics' "Need approval" KPI counts comp-desk rows whose
 * approvalStatus is 'required' or 'pending', and computeOfferApprovalStatus
 * only ever leaves 'not_required' while base <= band max. Every naturally
 * generated offer here sits inside its band, so without these two the tile
 * reads a permanent 0.
 *
 * Both land on 'required' (over band, no approval_request routed yet) rather
 * than one on 'pending': approval_requests.chain_id is NOT NULL and every
 * existing approval_chains row is a real per-request instance from another
 * feature. The KPI sums the two postures anyway, so the tile is identical and
 * the seed stays out of the approvals machinery.
 *
 * Both targets are 'offer_drafted' apps, so they sit on the comp desk
 * (COMP_DESK_STAGES) where the KPI reads from.
 */
const OVER_BAND = new Set([
  "sdl-head-automation:offer_drafted:0",
  "sap-plant-accountant:offer_drafted:1",
]);

/** Offer status for the Nth application at a given stage — shapes the funnel:
 * extended 14 / accepted 7 / declined 3, plus 1 drafted-only. */
function offerStatusFor(stage: Stage, nth: number): string | null {
  if (stage === "offer_accepted") return "accepted";
  if (stage === "offer_declined") return "declined";
  if (stage === "offer_drafted") {
    // 5 offer_drafted apps across the cohort: 1 drafted, 3 extended, 1 expired.
    return pick(["extended", "drafted", "extended", "expired", "extended"], nth);
  }
  return null;
}

/** Completed interview rounds for an application at `stage`, plus whether a
 * further round is merely scheduled. */
function roundsFor(stage: Stage): { completed: number[]; scheduled: number | null } {
  switch (stage) {
    case "tech_interview":
      return { completed: [], scheduled: 1 };
    case "hr_round":
      return { completed: [1], scheduled: 2 };
    case "withdrawn":
      return { completed: [1], scheduled: null };
    case "offer_drafted":
    case "offer_accepted":
    case "offer_declined":
      return { completed: [1, 2, 3], scheduled: null };
    default:
      return { completed: [], scheduled: null };
  }
}

const ROUND_NAMES: Record<number, string> = {
  1: "Technical deep-dive",
  2: "HR round",
  3: "Hiring manager",
};

/** Recommendation mix per round — pass rate climbs as the funnel narrows. */
const RECOMMENDATIONS: Record<number, string[]> = {
  1: ["strong_yes", "yes", "yes", "no", "hold", "yes", "strong_yes", "yes"],
  2: ["yes", "strong_yes", "yes", "hold", "strong_yes", "yes"],
  3: ["strong_yes", "yes", "strong_yes", "yes", "strong_yes"],
};

const SCORECARD_KEYS = ["problem_solving", "technical_depth", "communication", "culture_add"];

/** Curated benchmarks this seed owns. `median_salary_minor` is MINOR units
 * (paise); the Insights panel divides by 100 to meet the positions band, which
 * is MAJOR rupees.
 *
 * SOLENIS-MAP: retargeted onto two of the four cohort roles. The numbers and the
 * source note MIRROR seed-solenis-demo's curated rows exactly, so whichever seed
 * runs last the benchmark table is identical — the upsert converges instead of
 * the two seeds overwriting each other. */
const BENCHMARKS = [
  {
    roleTitle: "SDL / Head – Automation and Productivity (GBS)",
    medianMinor: "550000000", // ₹55L
    ttfDays: 75,
    availability: "low",
    demand: "high",
    rounds: 3,
    trendingSkills: ["Celonis", "GenAI adoption", "Automation CoE", "Value realisation"],
  },
  {
    roleTitle: "Non-SAP Plant Accountant",
    medianMinor: "140000000", // ₹14L
    ttfDays: 42,
    availability: "medium",
    demand: "medium",
    rounds: 2,
    trendingSkills: ["Cost Accounting", "Month-End Close", "Internal Controls", "Advanced Excel"],
  },
] as const;

/** Kept in lockstep with seed-solenis-demo's BENCHMARK_SOURCE_NOTE. */
const BENCHMARK_SOURCE_NOTE = "Curated benchmark — Solenis GBS pilot, update quarterly";

const BENCHMARK_TITLES = BENCHMARKS.map((b) => b.roleTitle);

const DAY_MS = 86_400_000;

/**
 * Timestamps go over the wire as ISO strings, never as Date objects.
 *
 * This connection runs with `prepare: false` (transaction-mode pooling), so
 * postgres-js binds parameters against the server's ParameterDescription and
 * hands a Date straight to its byte writer, which only accepts strings and
 * buffers. Same convention as seed-demo-data.ts. Passes null through so the
 * nullable offer timestamps can use it too.
 */
function ts(d: Date): string;
function ts(d: Date | null): string | null;
function ts(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

async function main(): Promise<void> {
  const undo = process.argv.includes("--undo");
  const { sql } = await import("../client");

  try {
    const [tenant] = await sql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found — refusing to run.`);
      process.exit(2);
    }
    const tid = tenant.id;

    if (undo) {
      await runUndo(sql, tid);
      return;
    }

    // SOLENIS-MAP: resolve the membership ids by email instead of trusting
    // hardcoded uuids from a database this seed may not be pointed at.
    for (const key of Object.keys(MEMBER_EMAILS) as MemberKey[]) {
      const email = MEMBER_EMAILS[key];
      const [m] = await sql<{ id: string }[]>`
        SELECT tum.id FROM public.tenant_user_memberships tum
        JOIN auth.users au ON au.id = tum.user_id
        WHERE tum.tenant_id = ${tid} AND tum.status = 'active' AND au.email = ${email}
        LIMIT 1
      `;
      if (!m) {
        console.error(`membership ${email} not found in ${TENANT_SLUG}; run db:seed:test-users.`);
        process.exit(2);
      }
      MEMBER[key] = m.id;
    }

    console.log(`Seeding analytics demo cohort into ${TENANT_SLUG} (${tid})\n`);

    // Resolve position ids for the reqs that didn't hardcode one.
    for (const r of REQS) {
      if (r.positionId) continue;
      const [row] = await sql<{ position_id: string }[]>`
        SELECT position_id FROM public.requisitions
        WHERE id = ${r.requisitionId} AND tenant_id = ${tid} LIMIT 1
      `;
      if (!row) throw new Error(`requisition ${r.requisitionId} (${r.roleTitle}) not found`);
      r.positionId = row.position_id;
    }

    // The hero req gets fix-ups the others don't (title, comp band).
    const hero = REQS.find((r) => r.key === "sdl-head-automation");
    if (!hero) throw new Error("the sdl-head-automation spec is missing from REQS");

    // ── 1. Fix-ups on pre-existing rows ──────────────────────────────────────
    // Re-assert the hero position's title + Leadership band (₹45–65 LPA, MAJOR
    // rupees) so this seed and seed-solenis-demo agree on the same numbers.
    await sql`
      UPDATE public.positions
         SET title = ${hero.roleTitle},
             comp_band_min = 4500000,
             comp_band_max = 6500000,
             comp_currency = 'INR',
             updated_at = now()
       WHERE id = ${hero.positionId} AND tenant_id = ${tid}
    `;
    await sql`
      UPDATE public.business_units SET name = 'GCC - Hyderabad', updated_at = now()
       WHERE id = ${HYDERABAD_BU} AND tenant_id = ${tid} AND name = 'GCC - Hyerabad'
    `;
    console.log("  ✓ re-asserted the hero position's title + Leadership comp band");

    for (const r of REQS) {
      await sql`
        UPDATE public.requisitions
           SET hiring_manager_id = ${MEMBER.hiringManager},
               number_of_openings = ${r.openings},
               status = COALESCE(${r.forceStatus ?? null}, status),
               updated_at = now()
         WHERE id = ${r.requisitionId} AND tenant_id = ${tid}
      `;
    }
    console.log(
      "  ✓ reassigned 4 reqs to hiringmanager1, set openings," +
        " SDL Head -> posted, Non-SAP Plant Accountant -> filled",
    );

    // The six PRE-EXISTING hires carry created_at equal to their own
    // offer_accepted transition, so each contributes a 0-day time-to-hire. The
    // hiring-manager persona never sees them (they sit on a recruiter-owned
    // req) but ADMIN's /insights rollup is every req in the tenant, which drags
    // the headline average from ~46d down to ~25d. Back-date them onto a
    // credible 41–54 day span, spread by accept order.
    //
    // Idempotent: the `created_at >= accepted_at - 1 day` guard means a row
    // already back-dated by an earlier run is skipped, so re-runs don't walk
    // these dates further and further into the past.
    const backdated = await sql`
      WITH acc AS (
        SELECT t.application_id,
               MIN(t.transitioned_at) AS accepted_at,
               ROW_NUMBER() OVER (ORDER BY MIN(t.transitioned_at)) AS rn
          FROM public.application_state_transitions t
         WHERE t.tenant_id = ${tid}
           AND t.to_stage = 'offer_accepted'
           AND t.application_id::text NOT LIKE ${`${ID_PREFIX}-%`}
         GROUP BY t.application_id
      )
      UPDATE public.applications a
         SET created_at = acc.accepted_at - (interval '1 day' * (39 + acc.rn * 2.5)),
             updated_at = now()
        FROM acc
       WHERE a.id = acc.application_id
         AND a.tenant_id = ${tid}
         AND a.created_at >= acc.accepted_at - interval '1 day'
      RETURNING a.id
    `;
    console.log(
      `  ✓ back-dated ${backdated.length} pre-existing hire(s) so admin's time-to-hire is real`,
    );

    // Curated benchmarks so the Insights salary-band panel has a median to plot
    // against the budget. The other two cohort roles (Senior Backend Engineer,
    // Data Platform Engineer) already have a benchmark row — these are the two
    // that don't. Matched by role title against positions.title.
    for (const b of BENCHMARKS) {
      await sql`
        INSERT INTO public.market_benchmarks
          (tenant_id, role_title, median_salary_minor, currency, ttf_days, availability,
           competitor_demand, recommended_rounds, trending_skills, source_note, updated_at)
        VALUES
          (${tid}, ${b.roleTitle}, ${b.medianMinor}, 'INR', ${b.ttfDays},
           ${b.availability}, ${b.demand}, ${b.rounds},
           ${JSON.stringify(b.trendingSkills)}::jsonb,
           ${BENCHMARK_SOURCE_NOTE}, now())
        ON CONFLICT (tenant_id, role_title) DO UPDATE SET
          median_salary_minor = EXCLUDED.median_salary_minor,
          ttf_days            = EXCLUDED.ttf_days,
          availability        = EXCLUDED.availability,
          competitor_demand   = EXCLUDED.competitor_demand,
          recommended_rounds  = EXCLUDED.recommended_rounds,
          trending_skills     = EXCLUDED.trending_skills,
          source_note         = EXCLUDED.source_note,
          updated_at          = now()
      `;
    }
    console.log(`  ✓ ${BENCHMARKS.length} market benchmarks (${BENCHMARK_TITLES.join(", ")})`);

    // JD skills for the reqs that had none of their own (skill-gap needs a JD
    // to compare candidates against, so an empty jd_skills renders an empty
    // panel). The other reqs already carry their real skills — this seed only
    // MIRRORS those into ReqSpec.skills to draw candidate skills from.
    let skillN = 0;
    for (const r of REQS.filter((x) => x.seedJdSkills)) {
      for (const s of r.skills) {
        await sql`
          INSERT INTO public.jd_skills
            (id, tenant_id, jd_version_id, skill_name, weight, is_required, created_at)
          VALUES (${mkId(KIND.jdSkill, skillN)}, ${tid}, ${r.jdVersionId},
                  ${s.name}, 1.00, ${s.required}, now())
          ON CONFLICT (id) DO UPDATE SET
            skill_name = EXCLUDED.skill_name, is_required = EXCLUDED.is_required
        `;
        skillN += 1;
      }
    }
    console.log(`  ✓ ${skillN} JD skills written (seed-solenis-demo owns the cohort JDs' skills)\n`);

    // ── 2. The cohort ────────────────────────────────────────────────────────
    const now = Date.now();
    let n = 0; // global candidate counter — drives ids, names, sources
    let transitionN = 0;
    let offerN = 0;
    let interviewN = 0;
    let feedbackN = 0;
    let panelistN = 0;
    const perStageNth: Record<string, number> = {};
    const summary = { apps: 0, offers: 0, interviews: 0, feedback: 0, transitions: 0 };

    // Wipe this seed's mutable rows so a re-run re-anchors every timestamp.
    await deleteSeededRows(sql, tid, { keepIdentities: true });

    for (const r of REQS) {
      for (const [stageKey, count] of Object.entries(r.cohort)) {
        const stage = stageKey as Stage;
        for (let k = 0; k < (count ?? 0); k++) {
          const i = n++;
          const personId = mkId(KIND.person, i);
          const candidateId = mkId(KIND.candidate, i);
          const applicationId = mkId(KIND.application, i);

          const first = pick(FIRST_NAMES, i);
          const last = pick(LAST_NAMES, i * 7 + 3);
          const fullName = `${first} ${last}`;
          const email = `${first}.${last}`.toLowerCase() + `.demo${i}@example.com`;
          const source = pick(SOURCES, i);
          const score = pick(SCORES[stage], k);

          // Candidate skills: a prefix of the req's JD skills, length varying by
          // score, so the skill-gap bars differ per skill instead of being flat.
          const pool = r.skills.length > 0 ? r.skills.map((s) => s.name) : DEFAULT_SKILLS;
          const take = Math.max(1, Math.min(pool.length, Math.round((score / 100) * pool.length)));
          const skills = pool.slice(0, take);
          const noticeDays = pick([15, 30, 45, 60, 90], i);
          const years = 6 + (i % 9);

          // Dates: build the chain, then anchor it so the final hop landed
          // RECENCY_DAYS ago.
          const jitter = (i % 7) - 3;
          const steps = chainFor(stage, jitter);
          const span = pick(steps, steps.length - 1).dayOffset;
          const recency =
            stage === "ai_screening" ? pick(AI_SCREENING_RECENCY_DAYS, i) : pick(RECENCY_DAYS, i);
          const createdAt = new Date(now - (span + recency) * DAY_MS);
          const at = (d: number) => new Date(createdAt.getTime() + d * DAY_MS);
          const stageEnteredAt = at(span);

          await sql`
            INSERT INTO public.persons
              (id, tenant_id, full_name, first_name, last_name, email_primary,
               email_normalised, phone_primary, location_country, location_city,
               linkedin_url, created_at, updated_at)
            VALUES (${personId}, ${tid}, ${fullName}, ${first}, ${last}, ${email},
                    ${email}, ${"+9198" + String(40000000 + i * 137).slice(0, 8)},
                    'IN', ${r.location},
                    ${"https://www.linkedin.com/in/" + first.toLowerCase() + "-" + last.toLowerCase() + "-demo" + i},
                    ${ts(createdAt)}, now())
            ON CONFLICT (id) DO UPDATE SET
              full_name = EXCLUDED.full_name, email_primary = EXCLUDED.email_primary,
              location_city = EXCLUDED.location_city, updated_at = now()
          `;

          await sql`
            INSERT INTO public.candidates
              (id, tenant_id, person_id, source, talent_pool_consent, consent_granted_at,
               current_resume_url, parsed_skills, years_of_experience,
               experience_summary, created_at, updated_at)
            VALUES (${candidateId}, ${tid}, ${personId}, ${source}, true, ${ts(createdAt)},
                    ${"https://demo.hireops.local/resumes/" + candidateId + ".pdf"},
                    ${JSON.stringify({
                      skills,
                      notice_period_days: noticeDays,
                      summary: `${years} years building ${r.roleTitle.toLowerCase()} systems.`,
                    })}::jsonb,
                    ${years}, ${`${years} yrs — ${skills.slice(0, 3).join(", ")}`},
                    ${ts(createdAt)}, now())
            ON CONFLICT (id) DO UPDATE SET
              parsed_skills = EXCLUDED.parsed_skills,
              years_of_experience = EXCLUDED.years_of_experience,
              updated_at = now()
          `;

          const expected = Math.round(r.offerBaseRupees * (0.9 + (i % 5) * 0.06)) * 100;
          await sql`
            INSERT INTO public.applications
              (id, tenant_id, candidate_id, requisition_id, source, current_stage,
               stage_entered_at, assigned_recruiter_membership_id, ai_score, ai_scored_at,
               expected_salary_inr_paise, created_at, updated_at)
            VALUES (${applicationId}, ${tid}, ${candidateId}, ${r.requisitionId}, ${source},
                    ${stage}, ${ts(stageEnteredAt)}, ${MEMBER.recruiter}, ${score}, ${ts(at(1))},
                    ${String(expected)}, ${ts(createdAt)}, now())
            ON CONFLICT (id) DO UPDATE SET
              current_stage = EXCLUDED.current_stage,
              stage_entered_at = EXCLUDED.stage_entered_at,
              ai_score = EXCLUDED.ai_score,
              expected_salary_inr_paise = EXCLUDED.expected_salary_inr_paise,
              created_at = EXCLUDED.created_at,
              updated_at = now()
          `;
          summary.apps += 1;

          // Transitions — the full dated chain, so time-to-hire and
          // time-in-stage both compute.
          for (let s = 0; s < steps.length; s++) {
            const step = pick(steps, s);
            await sql`
              INSERT INTO public.application_state_transitions
                (id, tenant_id, application_id, from_stage, to_stage, transitioned_at,
                 actor_membership_id, reason)
              VALUES (${mkId(KIND.transition, transitionN++)}, ${tid}, ${applicationId},
                      ${s === 0 ? null : pick(steps, s - 1).stage}, ${step.stage},
                      ${ts(at(step.dayOffset))}, ${MEMBER.recruiter}, 'analytics demo seed')
            `;
            summary.transitions += 1;
          }

          // Offers.
          const nthKey = `offer:${stage}`;
          const nth = perStageNth[nthKey] ?? 0;
          const offerStatus = offerStatusFor(stage, nth);
          if (offerStatus) {
            perStageNth[nthKey] = nth + 1;
            const draftedAt = at(span - (stage === "offer_drafted" ? 0 : 8));
            const extendedAt = offerStatus === "drafted" ? null : draftedAt;
            const acceptedAt = offerStatus === "accepted" ? at(span) : null;
            const declinedAt = offerStatus === "declined" ? at(span) : null;
            // Two offers are pushed 8% clear of the band max so the comp desk
            // has something in the 'required' approval posture (see OVER_BAND).
            const overBand = OVER_BAND.has(`${r.key}:${stage}:${k}`);
            const base = overBand
              ? Math.round(r.bandMaxRupees * 1.08) * 100
              : Math.round(r.offerBaseRupees * (0.94 + (i % 4) * 0.04)) * 100;
            const joining = at(span + 45);
            await sql`
              INSERT INTO public.offers
                (id, tenant_id, application_id, drafted_by_membership_id,
                 base_salary_inr_paise, variable_target_inr_paise, joining_bonus_inr_paise,
                 joining_date, location, expiry_at, status, extended_at, accepted_at,
                 declined_at, declined_reason, contract_type, probation_months,
                 created_at, updated_at)
              VALUES (${mkId(KIND.offer, offerN++)}, ${tid}, ${applicationId}, ${MEMBER.hrOps},
                      ${String(base)}, ${String(Math.round(base * 0.15))}, ${String(Math.round(base * 0.08))},
                      ${joining.toISOString().slice(0, 10)}, ${r.location},
                      ${ts(at(span + 14))}, ${offerStatus}, ${ts(extendedAt)}, ${ts(acceptedAt)},
                      ${ts(declinedAt)}, ${declinedAt ? "Accepted a competing offer" : null},
                      'full_time', 6, ${ts(draftedAt)}, now())
            `;
            summary.offers += 1;
          }

          // Interviews + panel feedback.
          const { completed, scheduled } = roundsFor(stage);
          for (const round of completed) {
            const interviewId = mkId(KIND.interview, interviewN++);
            const start = at(span - (completed.length - round + 1) * 4);
            await sql`
              INSERT INTO public.interviews
                (id, tenant_id, application_id, requisition_id, round_number, round_name,
                 status, scorecard_template, scheduled_start, scheduled_end,
                 duration_minutes, mode, meeting_url, candidate_confirmed_at,
                 created_by_membership_id, created_at, updated_at)
              VALUES (${interviewId}, ${tid}, ${applicationId}, ${r.requisitionId},
                      ${round}, ${ROUND_NAMES[round] ?? `Round ${round}`}, 'completed', 'general',
                      ${ts(start)}, ${ts(new Date(start.getTime() + 3_600_000))}, 60, 'video',
                      ${"https://meet.demo.local/" + interviewId.slice(-8)}, ${ts(start)},
                      ${MEMBER.recruiter}, ${ts(start)}, now())
            `;
            summary.interviews += 1;

            // Two panellists, two scorecards — the trends chart aggregates these.
            const panelMembers: string[] = [MEMBER.panel, MEMBER.hiringManager];
            for (let p = 0; p < panelMembers.length; p++) {
              const panellist = pick(panelMembers, p);
              await sql`
                INSERT INTO public.interview_panelists
                  (id, tenant_id, interview_id, membership_id, is_lead, created_at, updated_at)
                VALUES (${mkId(KIND.panelist, panelistN++)}, ${tid}, ${interviewId},
                        ${panellist}, ${p === 0}, ${ts(start)}, now())
              `;

              const rec = pick(RECOMMENDATIONS[round] ?? ["yes"], i + p);
              // Scorecard values track the recommendation so mean and pass-rate
              // tell a consistent story.
              const bandBase =
                rec === "strong_yes" ? 5 : rec === "yes" ? 4 : rec === "hold" ? 3 : 2;
              const scorecard: Record<string, number> = {};
              SCORECARD_KEYS.forEach((key, ki) => {
                scorecard[key] = Math.max(1, Math.min(5, bandBase - ((i + ki + p) % 2)));
              });
              await sql`
                INSERT INTO public.interview_feedback
                  (id, tenant_id, interview_id, membership_id, scorecard, strengths,
                   concerns, recommendation, submitted_at, created_at, updated_at)
                VALUES (${mkId(KIND.feedback, feedbackN++)}, ${tid}, ${interviewId},
                        ${panellist}, ${JSON.stringify(scorecard)}::jsonb,
                        ${"Strong grasp of " + pick(skills, 0) + "; clear structured thinking."},
                        ${rec === "no" ? "Depth gaps on system design under load." : "Minor gaps, coachable."},
                        ${rec}, ${ts(new Date(start.getTime() + 7_200_000))}, ${ts(start)}, now())
              `;
              summary.feedback += 1;
            }
          }

          if (scheduled !== null) {
            const interviewId = mkId(KIND.interview, interviewN++);
            const start = at(span + 3);
            await sql`
              INSERT INTO public.interviews
                (id, tenant_id, application_id, requisition_id, round_number, round_name,
                 status, scorecard_template, scheduled_start, scheduled_end,
                 duration_minutes, mode, meeting_url, created_by_membership_id,
                 created_at, updated_at)
              VALUES (${interviewId}, ${tid}, ${applicationId}, ${r.requisitionId},
                      ${scheduled}, ${ROUND_NAMES[scheduled] ?? `Round ${scheduled}`}, 'scheduled', 'general',
                      ${ts(start)}, ${ts(new Date(start.getTime() + 3_600_000))}, 60, 'video',
                      ${"https://meet.demo.local/" + interviewId.slice(-8)},
                      ${MEMBER.recruiter}, ${ts(stageEnteredAt)}, now())
            `;
            summary.interviews += 1;
          }
        }
      }
    }

    console.log(`  ✓ ${summary.apps} applications across ${REQS.length} requisitions`);
    console.log(`  ✓ ${summary.transitions} dated state transitions`);
    console.log(`  ✓ ${summary.offers} offers`);
    console.log(`  ✓ ${summary.interviews} interviews, ${summary.feedback} submitted scorecards`);
    console.log("\nAnalytics demo cohort seeded. Undo with: pnpm db:seed:analytics-demo -- --undo");
  } finally {
    await sql.end({ timeout: 10 });
  }
}

const DEFAULT_SKILLS = ["Python", "SQL", "AWS", "Airflow", "Spark", "dbt"];

type SqlClient = (typeof import("../client"))["sql"];

/** Deletes rows this seed owns, in FK-safe order. `keepIdentities` retains the
 * person/candidate rows (their content is stable) while clearing everything
 * whose timestamps must re-anchor on a re-run. */
async function deleteSeededRows(
  sql: SqlClient,
  tid: string,
  opts: { keepIdentities: boolean },
): Promise<void> {
  const pfx = `${ID_PREFIX}-%`;
  await sql`DELETE FROM public.interview_feedback WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.interview_panelists WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  // Scoped by the APPLICATION, not by this seed's id prefix. An interview
  // booked through the app carries a random uuid, so a prefix-only delete left
  // it behind and the seed's own insert for that (application, round) then hit
  // uniq_interviews_application_round_active and aborted the run half-applied.
  // This seed owns these applications outright, so every interview hanging off
  // one is ours to clear — that is what makes a re-run actually idempotent
  // after a tester has scheduled or rescheduled a round on the cohort.
  // Panelists and feedback cascade from the interview row.
  await sql`
    DELETE FROM public.interviews
     WHERE tenant_id = ${tid}
       AND (id::text LIKE ${pfx} OR application_id::text LIKE ${pfx})
  `;
  await sql`DELETE FROM public.offers WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  if (!opts.keepIdentities) {
    await sql`DELETE FROM public.applications WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
    await sql`DELETE FROM public.candidates WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
    await sql`DELETE FROM public.persons WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
    await sql`DELETE FROM public.jd_skills WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  }
}

async function runUndo(sql: SqlClient, tid: string): Promise<void> {
  console.log(`Removing analytics demo cohort from ${TENANT_SLUG} (${tid})`);
  await deleteSeededRows(sql, tid, { keepIdentities: false });
  // Only the benchmarks this seed introduced — the pre-existing rows for the
  // other cohort roles are not ours to remove.
  await sql`
    DELETE FROM public.market_benchmarks
     WHERE tenant_id = ${tid} AND role_title IN ${sql(BENCHMARK_TITLES)}
  `;
  console.log(
    `  ✓ removed every 0000ad00-* row + the ${BENCHMARK_TITLES.length} seeded benchmarks`,
  );
  console.log(
    "  ! NOT reverted (pre-existing rows this seed edited): requisition hiring-manager /" +
      " openings / status, the position comp band + title fix, the business-unit name fix," +
      " and the back-dated created_at on the pre-existing hires.",
  );
}

main().catch((err) => {
  console.error("seed-analytics-demo failed:", err);
  process.exit(1);
});
