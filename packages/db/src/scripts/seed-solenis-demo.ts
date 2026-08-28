/**
 * SOLENIS-MAP — maps Solenis GBS India's questionnaire + JD pack onto the
 * Solenis demo environment, so every surface speaks THEIR roles, THEIR bands,
 * THEIR approval chain and THEIR interview structure instead of the generic
 * GCC-tech demo corpus.
 *
 * Source of truth: the client questionnaire + the three JDs in
 * `public/solenis demo data/` (SDL Head docx, Transformation & CI Manager docx,
 * Program & Transformation Lead pdf) + their open-position tracker.
 *
 * WHAT IT SEEDS
 *   1.  tenant identity      — display_name "Solenis GBS India" + settings.branding
 *                              (atomic jsonb `||` merge; every sibling key survives)
 *   2.  SLA thresholds       — settings.slaThresholds, ONLY the three stages they
 *                              named; every other stage is left at the code default
 *                              by OMISSION (resolveSlaThresholds merges over defaults)
 *   3.  comp bands           — IN09 / IN12 / IN14 / Leadership (MAJOR INR rupees)
 *   4.  business unit + envelope — "GBS India — Hyderabad"
 *   5.  8 requisitions       — 5 from the open-position tracker + 3 from the JD pack,
 *                              with positions (band-linked), jd_versions, jd_skills,
 *                              interview_plans
 *   6.  market benchmarks    — 8 curated rows for THEIR titles; the generic tech rows
 *                              (DevOps Engineer, Staff Frontend Engineer, …) are
 *                              REMOVED for this tenant — a GBS client whose market
 *                              intelligence opens on "DevOps Engineer" is a demo own-goal
 *   7.  approval routing     — requisition + offer matrices named for their real chain
 *   8.  interview templates  — their rating-sheet criteria as two custom scorecards +
 *                              the 3-round senior loop as the tenant default
 *   9.  sourcing channels    — relabelled to their channel mix
 *  10.  partner org "Hudson" — empanelled + a LIVE agreed MSA (without an MSA the
 *                              Commercials tab renders empty)
 *  11.  pipeline             — 34 applications across the 8 reqs, stage-spread and
 *                              back-dated so SLA/ageing shows healthy AND breaching rows
 *  12.  onboarding doc types — the India joining-document set they listed
 *
 * MONEY UNITS (checked against apps/api/src/lib/comp-rules.ts):
 *   - positions.comp_band_min/max + comp_bands.min_major/max_major → MAJOR rupees
 *   - applications.expected_salary_inr_paise + market_benchmarks.median_salary_minor
 *     → MINOR units (paise). 1 LPA = 100,000 rupees = 10,000,000 paise.
 *
 * COMP BANDS ARE DEMO VALUES. Solenis gave band LABELS (IN09/IN12/IN14), not
 * numbers. The rupee ranges below are plausible Hyderabad GBS values chosen so
 * the comp desk tells a coherent story — they are NOT client-supplied and must
 * be confirmed before any real use.
 *
 * IDEMPOTENT. Deterministic ids in a FRESH `00000000-0000-4000-9000-…` namespace
 * (the generic demo suite owns a5xx/a6xx/a7xx/a8xx; analytics owns 0000ad00-*).
 * Static rows upsert on id; pipeline rows are delete-then-reinsert so
 * stage_entered_at re-anchors every run (the ageing views always look current).
 *
 * GROOM-SAFE: the 9000 namespace matches no residue class in groom-demo-data.ts
 * (not the bbXX test namespace, no ticket-code titles, no uuid-fallback slugs)
 * and every seeded person uses `@example.test`, not the swept `@example.com`.
 *
 * Run:   pnpm db:seed:solenis-demo
 * Undo:  pnpm db:seed:solenis-demo -- --undo
 *
 * Prerequisite: pnpm db:seed:test-users (recruiter1 / hiringmanager1 / hrhead1 /
 * panel1 / admin1 memberships).
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

/**
 * Host guard. The repo-root `.env` this script dotenv-loads points at the OLD
 * staging database; the Solenis env is supplied by EXPORTED variables, which
 * dotenv does not overwrite. If the exported env was forgotten we would silently
 * rewrite the wrong tenant's identity, so refuse to do anything at all unless
 * the connection string names the Solenis project.
 */
const REQUIRED_DB_HOST_FRAGMENT = "wbjwudtyyblvyirbkrsp";

const RECRUITER_EMAIL = "recruiter1@mindssparc.com";
const HIRING_MANAGER_EMAIL = "hiringmanager1@mindssparc.com";
const HR_HEAD_EMAIL = "hrhead1@mindssparc.com";
const PANEL_EMAIL = "panel1@mindssparc.com";
const ADMIN_EMAIL = "admin1@mindssparc.com";

// ───────────────────────────── id namespace ─────────────────────────────
//
// `00000000-0000-4000-9000-<kk><nnnnnnnnnn>` — kk is the row kind, n the index.
// Variant nibble 9 is a valid RFC-4122 variant, and the block is untouched by
// every other seed (which live in the …-8000-… variant space).
const ID_PREFIX = "00000000-0000-4000-9000";

const KIND = {
  businessUnit: 0x01,
  envelope: 0x02,
  compBand: 0x03,
  position: 0x10,
  jdVersion: 0x11,
  requisition: 0x12,
  jdSkill: 0x13,
  interviewPlan: 0x14,
  person: 0x20,
  candidate: 0x21,
  application: 0x22,
  transition: 0x23,
  approvalMatrix: 0x30,
  scorecard: 0x31,
  roundTemplate: 0x32,
  partnerOrg: 0x40,
  partnerMsa: 0x41,
  partnerAssignment: 0x42,
  documentType: 0x50,
} as const;

function mkId(kind: number, n: number): string {
  const tail = kind.toString(16).padStart(2, "0") + n.toString(16).padStart(10, "0");
  return `${ID_PREFIX}-${tail}`;
}

/** Wrapping index that satisfies noUncheckedIndexedAccess. */
function pick<T>(pool: readonly T[], i: number): T {
  if (pool.length === 0) throw new Error("pick() on an empty pool");
  const v = pool[((i % pool.length) + pool.length) % pool.length];
  if (v === undefined) throw new Error("pick() produced undefined");
  return v;
}

/** Timestamps cross the wire as ISO strings — the pooled connection runs with
 * `prepare: false` and postgres-js's byte writer only accepts strings/buffers
 * for a described parameter. Same convention as seed-demo-data / analytics. */
function ts(d: Date): string {
  return d.toISOString();
}

/** 1 LPA → INR paise, as a string (the tagged-template client won't bind a raw
 * bigint). 1 LPA = 100,000 rupees = 10,000,000 paise. */
const lpaToPaise = (lpa: number): string => Math.round(lpa * 10_000_000).toString();

/** 1 LPA → MAJOR rupees (the positions / comp_bands convention). */
const lpaToRupees = (lpa: number): string => Math.round(lpa * 100_000).toFixed(2);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ─────────────────────────── 1. tenant identity ───────────────────────────

const TENANT_DISPLAY_NAME = "Solenis GBS India";
/** Solenis brand green + the logo they supplied, uploaded to the demo bucket. */
const BRANDING = {
  primaryColor: "#00CC99",
  logoUrl:
    "https://wbjwudtyyblvyirbkrsp.supabase.co/storage/v1/object/public/branding/solenis-logo.svg",
  // Not client-specified; the platform default, written explicitly so the
  // resolved block is complete (brandingSettingsSchema defaults it to false).
  darkModeDefault: false,
};

/**
 * 2. SLA thresholds, in hours, from their questionnaire:
 *   - candidate response       48h  → application_received
 *   - hiring-manager feedback  3 days → recruiter_review (72h)
 *   - offer release            5 days → offer_drafted (120h)
 * Every other stage is deliberately ABSENT: resolveSlaThresholds merges a
 * partial override map over SLA_THRESHOLDS_HOURS, so omission = "keep the
 * platform default", which is exactly what they asked for.
 */
const SLA_THRESHOLDS = {
  application_received: 48,
  recruiter_review: 72,
  offer_drafted: 120,
};

// ─────────────────────────── 3. comp bands ───────────────────────────
//
// DEMO VALUES (see header). Labels are theirs; the rupee ranges are ours.
interface BandSeed {
  key: "IN09" | "IN12" | "IN14" | "LEAD";
  id: string;
  name: string;
  level: string;
  minLpa: number;
  maxLpa: number;
}

const BANDS: BandSeed[] = [
  {
    key: "IN09",
    id: mkId(KIND.compBand, 1),
    name: "Solenis IN09 — Assistant / Analyst",
    level: "IN09",
    minLpa: 6,
    maxLpa: 9,
  },
  {
    key: "IN12",
    id: mkId(KIND.compBand, 2),
    name: "Solenis IN12 — Specialist / Senior Analyst",
    level: "IN12",
    minLpa: 12,
    maxLpa: 18,
  },
  {
    key: "IN14",
    id: mkId(KIND.compBand, 3),
    name: "Solenis IN14 — Lead / Coordinator",
    level: "IN14",
    minLpa: 20,
    maxLpa: 28,
  },
  {
    key: "LEAD",
    id: mkId(KIND.compBand, 4),
    name: "Solenis Leadership — SDL / Head",
    level: "Leadership",
    minLpa: 45,
    maxLpa: 65,
  },
];

const BAND_BY_KEY = new Map(BANDS.map((b) => [b.key, b]));
function band(key: BandSeed["key"]): BandSeed {
  const b = BAND_BY_KEY.get(key);
  if (!b) throw new Error(`unknown band ${key}`);
  return b;
}

// ─────────────────────── 4. business unit + envelope ───────────────────────

const SOLENIS_BU = mkId(KIND.businessUnit, 1);
const SOLENIS_BU_NAME = "GBS India — Hyderabad";
const SOLENIS_BU_SLUG = "gbs-india-hyd";
const SOLENIS_ENVELOPE = mkId(KIND.envelope, 1);

const HYDERABAD = "Hyderabad";

// ─────────────────────────── 5. requisitions ───────────────────────────

type Seniority = "junior" | "mid" | "senior";

interface RoleSeed {
  key: string;
  index: number;
  title: string;
  slug: string;
  /** Their band label — lands on positions.level AND drives comp_band_id. */
  bandKey: BandSeed["key"];
  /** Their functional grouping — lands on positions.function. */
  jobFunction: string;
  /**
   * The hiring manager AS THEY NAME THEM. The data model has no free-text
   * hiring-manager name (requisitions.hiring_manager_id is a membership FK and
   * we are not creating auth users), so this name is surfaced in the JD body +
   * the jd_versions.summary line instead. See the "not expressible" note in the
   * hand-back.
   */
  hiringManagerName: string;
  seniority: Seniority;
  openings: number;
  status: "posted" | "pending_approval" | "filled";
  skills: string[];
  summary: string;
  jdText: string;
}

/** Shared closing block for the five tracker JDs we author ourselves. */
function gbsLogistics(bandLabel: string, hm: string): string {
  return `## Logistics
- Location: Hyderabad, India (Solenis GBS India centre). Hybrid, 3 days on site.
- Band: ${bandLabel}. Reports to ${hm}.
- Shift overlap with US/EMEA stakeholders as the process calendar requires.
`;
}

const ROLES: RoleSeed[] = [
  // ───── the five open positions from their tracker ─────
  {
    key: "accounting-assistant-iii",
    index: 1,
    title: "Accounting Assistant III",
    slug: "solenis-hyd-accounting-assistant-iii",
    bandKey: "IN09",
    jobFunction: "Finance",
    hiringManagerName: "Raghu Mehra",
    seniority: "junior",
    openings: 2,
    status: "posted",
    skills: ["SAP FI", "Accounts Payable", "Account Reconciliation", "Advanced Excel", "ERP Data Entry"],
    summary: "Transactional finance support for the GBS record-to-report and purchase-to-pay towers. Hiring manager: Raghu Mehra.",
    jdText: `# Accounting Assistant III — Solenis GBS India, Hyderabad

## About the role
The Accounting Assistant III supports the day-to-day transactional finance
work that runs through Solenis GBS India — invoice processing, account
reconciliations, journal preparation and the routine controls that keep the
purchase-to-pay and record-to-report towers clean. You will work to a defined
process calendar with clear service levels, alongside colleagues in the same
tower and the regional finance teams you support.

## What you'll do
- Process supplier invoices and employee claims in SAP against agreed SLAs,
  resolving exceptions with the requisitioner or the regional controller.
- Prepare and post routine journals; perform balance-sheet account
  reconciliations and clear ageing items to the agreed threshold.
- Support the month-end close checklist for your accounts — accruals,
  prepayments, intercompany matching and the supporting schedules.
- Maintain evidence for internal control testing and respond to audit
  sampling requests within the agreed turnaround.
- Flag repeat exceptions and rework so the continuous-improvement team can
  qualify them as automation or process-fix opportunities.

## Must-have
- 2–5 years in a shared-services or captive finance environment.
- Hands-on SAP FI transactional experience (invoice entry, GL postings).
- Comfortable reconciling accounts and explaining a variance in writing.
- Advanced Excel (lookups, pivots) and a genuinely careful eye for detail.

## Nice-to-have
- Exposure to a global process-owner operating model and tiered service delivery.
- B.Com / M.Com or a part-qualified accounting credential.

${gbsLogistics("IN09", "Raghu Mehra, Finance Tower Lead")}`,
  },
  {
    key: "business-coordinator",
    index: 2,
    title: "Business Coordinator",
    slug: "solenis-hyd-business-coordinator",
    bandKey: "IN14",
    jobFunction: "SAP & Business Support",
    hiringManagerName: "Suman",
    seniority: "mid",
    openings: 1,
    status: "posted",
    skills: ["SAP SD", "Order Management", "Stakeholder Management", "Advanced Excel", "Process Documentation"],
    summary: "Coordinates SAP-enabled business support across order management and master data. Hiring manager: Suman.",
    jdText: `# Business Coordinator — Solenis GBS India, Hyderabad

## About the role
The Business Coordinator is the connective tissue between the GBS SAP and
business-support team and the commercial, supply-chain and customer-service
stakeholders it serves. You own the coordination layer: intake, prioritisation,
status, escalation and the documentation that makes a shared-services process
repeatable rather than personality-dependent.

## What you'll do
- Own the intake queue for SAP-enabled business-support requests — triage,
  route, chase and close, with a defensible audit trail on every item.
- Coordinate order-management, pricing and master-data changes end to end,
  keeping the requesting function informed at each hand-off.
- Run the operating cadence: status packs, KPI/SLA reporting, action trackers
  and the weekly review with tower leads.
- Maintain process documentation, SOPs and work instructions; keep them
  current as the operating model changes.
- Identify friction and rework in the coordination flow and put it into the
  transformation pipeline with a sized benefit.

## Must-have
- 6–10 years in shared services / GBS with a coordination or business-support
  remit across multiple functions.
- Working SAP knowledge (SD or MM) and confidence with master-data concepts.
- Demonstrable stakeholder management with senior business contacts.
- Strong written communication — you will write the SOP everyone else follows.

## Nice-to-have
- Experience standing up a new tower or migrating scope into a GBS centre.
- Power BI or equivalent for the operating cadence reporting.

${gbsLogistics("IN14", "Suman, Business Support Lead")}`,
  },
  {
    key: "sap-plant-accountant",
    index: 3,
    title: "SAP Plant Accountant",
    slug: "solenis-hyd-sap-plant-accountant",
    bandKey: "IN12",
    jobFunction: "Finance",
    hiringManagerName: "Raghu Mehra",
    seniority: "mid",
    openings: 2,
    status: "posted",
    skills: ["SAP FI/CO", "Plant Accounting", "Inventory Valuation", "Month-End Close", "IFRS"],
    summary: "Plant-side controlling and inventory accounting in SAP for the manufacturing network. Hiring manager: Raghu Mehra.",
    jdText: `# SAP Plant Accountant — Solenis GBS India, Hyderabad

## About the role
The SAP Plant Accountant owns the accounting for a portfolio of manufacturing
sites from the GBS India centre — inventory valuation, standard costing,
production variance analysis and the month-end close for those plants. This is
a controlling role run out of SAP FI/CO, working directly with plant
controllers and site operations leadership.

## What you'll do
- Run the month-end close for your plants: inventory valuation, WIP,
  production-order settlement, variance analysis and the reporting pack.
- Maintain standard costs and material ledger data; investigate and explain
  purchase-price and production variances to the plant controller.
- Own balance-sheet integrity for plant accounts — reconciliations,
  provisioning, physical-inventory and cycle-count accounting.
- Support internal and external audit for your sites, including the SOX-style
  control evidence over inventory and costing.
- Partner with the transformation team to simplify and automate the close.

## Must-have
- 5–9 years in manufacturing / plant accounting, ideally in a GBS or captive.
- Deep SAP FI/CO — material ledger, product costing, production-order settlement.
- Confident with inventory valuation and variance analysis under IFRS.
- Able to hold your own with a plant controller on the numbers.

## Nice-to-have
- CMA / CA (Inter) or equivalent.
- Chemicals, process-industry or other continuous-manufacturing background.

${gbsLogistics("IN12", "Raghu Mehra, Finance Tower Lead")}`,
  },
  {
    key: "tableau-analyst",
    index: 4,
    title: "Tableau Analyst",
    slug: "solenis-hyd-tableau-analyst",
    bandKey: "IN12",
    jobFunction: "IT",
    hiringManagerName: "Chandramouli",
    seniority: "mid",
    // 2 openings: seed-analytics-demo builds a 2-hire cohort on this
    // requisition, and fill rate is hires/openings — keep the two seeds
    // agreeing so a re-run of either does not make the card read 200%.
    openings: 2,
    status: "posted",
    skills: ["Tableau", "SQL", "Data Modelling", "Alteryx", "Power BI"],
    summary: "Builds the reporting and visual analytics layer the GBS towers run on. Hiring manager: Chandramouli.",
    jdText: `# Tableau Analyst — Solenis GBS India, Hyderabad

## About the role
The Tableau Analyst builds and maintains the reporting layer the GBS towers
run their operations on — productivity dashboards, SLA and KPI reporting, and
the analytical products that let functional leaders see where work, cost and
risk actually sit. You will sit inside the GBS IT & analytics team and work
directly with process owners across Finance, HRSS, Supply Chain and Commercial.

## What you'll do
- Design, build and maintain Tableau dashboards and data sources against
  agreed definitions, with documented lineage back to the source system.
- Write and tune the SQL behind those dashboards; model the data so a metric
  means one thing everywhere it appears.
- Prepare and automate data flows (Alteryx or equivalent) so refreshes are
  hands-off and auditable.
- Work with process owners to turn a reporting ask into a real measurement
  definition — baseline, denominator, owner and refresh cadence.
- Support the productivity and value-realisation agenda with credible,
  reconciled numbers rather than one-off extracts.

## Must-have
- 4–8 years in BI / visual analytics with Tableau as your primary tool.
- Strong SQL and dimensional data-modelling instincts.
- Experience serving shared-services or finance stakeholders.
- The judgement to say when a number is not yet trustworthy.

## Nice-to-have
- Alteryx, Power BI, or Snowflake / SAP BW exposure.
- Familiarity with process-mining output (Celonis) as a data source.

${gbsLogistics("IN12", "Chandramouli, GBS IT & Analytics Lead")}`,
  },
  {
    key: "non-sap-plant-accountant",
    index: 5,
    title: "Non-SAP Plant Accountant",
    slug: "solenis-hyd-non-sap-plant-accountant",
    bandKey: "IN12",
    jobFunction: "Finance",
    hiringManagerName: "Raghu Mehra",
    seniority: "mid",
    openings: 1,
    // Seeded FILLED on purpose: the analytics surfaces need at least one closed
    // requisition for fill-rate and demand-by-department's "filled" series to be
    // non-zero. Flip to "posted" if the client wants all five tracker roles open.
    status: "filled",
    skills: ["Plant Accounting", "Cost Accounting", "Month-End Close", "Advanced Excel", "Internal Controls"],
    summary: "Plant accounting for the sites not yet migrated onto SAP. Hiring manager: Raghu Mehra.",
    jdText: `# Non-SAP Plant Accountant — Solenis GBS India, Hyderabad

## About the role
Not every Solenis manufacturing site sits on SAP. The Non-SAP Plant Accountant
owns the accounting for those sites from the GBS India centre, working out of
legacy and local ERP systems plus a controlled set of spreadsheets — and doing
it to the same standard of accuracy, control and close discipline as the SAP
estate.

## What you'll do
- Run the month-end close for the non-SAP plants: inventory, cost of goods,
  accruals, variance analysis and the reporting pack into group consolidation.
- Rebuild and maintain the costing model for those sites where the local
  system cannot produce it natively.
- Own the reconciliation between local ledgers and the group reporting
  hierarchy; investigate and clear differences.
- Keep control evidence audit-ready in an environment with weaker system
  controls — compensating controls, review evidence, segregation of duties.
- Feed the migration roadmap: document what the site does today so the SAP
  cut-over team is not discovering it late.

## Must-have
- 5–9 years in plant, cost or manufacturing accounting.
- Strong cost-accounting fundamentals independent of any one system.
- Advanced Excel and the discipline to make a spreadsheet process controlled.
- Comfort operating with ambiguity and incomplete system support.

## Nice-to-have
- Prior involvement in an ERP migration or finance-systems cut-over.
- CMA / CA (Inter) or equivalent.

${gbsLogistics("IN12", "Raghu Mehra, Finance Tower Lead")}`,
  },

  // ───── the three roles from their JD pack ─────
  {
    key: "sdl-head-automation",
    index: 6,
    title: "SDL / Head – Automation and Productivity (GBS)",
    slug: "solenis-hyd-sdl-head-automation-productivity",
    bandKey: "LEAD",
    jobFunction: "Transformation & Productivity",
    hiringManagerName: "Head of GBS",
    seniority: "senior",
    openings: 1,
    status: "posted",
    skills: [
      "Celonis / Process Mining",
      "RPA",
      "AI / GenAI Adoption",
      "Automation Governance",
      "SAP",
      "Value Realisation",
    ],
    summary:
      "Single accountable leader for GBS automation, AI adoption, productivity delivery and value realisation. Reports to the Head of GBS.",
    jdText: `# SDL / Head – Automation and Productivity (GBS)

## Role overview
The SDL / Head – GBS Automation and Productivity will lead the automation, AI
adoption, productivity enablement, governance, delivery and value-realisation
agenda across Global Business Services. The role is accountable for building a
structured and scalable automation and productivity engine that supports
year-on-year efficiency improvement across GBS functions and sites.

This leader is the strategic and operational bridge between Group AI
initiatives, GBS transformation priorities, IT / enterprise architecture and
the business functions — translating GBS productivity targets into prioritised
automation roadmaps, measurable initiatives, delivery plans and sustained
benefit realisation.

**Location:** Hyderabad initially, with responsibility to scale automation and
productivity playbooks across all GBS sites.
**Reporting line:** Reports to the Head of GBS.

## Role context and business need
Automation, AI, RPA, analytics, process mining and productivity initiatives are
currently managed across multiple teams and functions. That has created pockets
of progress, but also fragmentation, duplication, slower speed-to-value,
inconsistent governance and limited visibility of enterprise-wide benefit.

- Establish ONE accountable lead for GBS automation, AI adoption, productivity
  delivery and value realisation.
- Convert GBS productivity targets into a qualified pipeline of automation
  opportunities, roadmaps and measurable outcomes.
- Create a unified demand intake, prioritisation, governance and delivery model.
- Improve utilisation of strategic platforms — Celonis, RPA, low-code / no-code,
  AI / GenAI and SaaS.
- Reduce duplication and uncoordinated technology adoption.
- Build reusable playbooks, assets and standards that scale beyond Hyderabad.

## Key responsibilities
### 1. Strategy, roadmap and leadership
- Develop and maintain the GBS automation and productivity roadmap, aligned to
  GBS strategy, enterprise AI priorities and functional productivity targets.
- Identify, shape and prioritise high-value automation, AI, process-mining and
  productivity opportunities across GBS functions.
- Partner with GBS leadership, functional leaders, IT and enterprise
  architecture so initiatives are business-led, scalable, secure and standard.

### 2. Governance, architecture and standards
- Establish governance for automation, AI, tools, platforms, demand intake,
  prioritisation, solution design, delivery and benefits tracking.
- Define approved technology standards, security requirements and reusable
  design patterns with IT and enterprise architecture.
- Create guardrails for low-code / no-code, citizen development, AI / GenAI
  adoption, process mining, RPA and SaaS automation.

### 3. Delivery and portfolio management
- Act as the single delivery lead across the AI COE, Celonis value architects,
  RPA, low-code teams, SaaS application teams and functional SMEs.
- Manage a transparent automation portfolio from ideation through business case,
  delivery, adoption and benefit realisation.
- Track progress, risk, dependency, financial impact and capacity release
  through structured governance forums.

### 4. Productivity enablement and value realisation
- Translate each function's annual productivity target into automation-enabled
  savings, capacity release and process simplification.
- Maintain a consolidated productivity pipeline: opportunities, validated
  business cases, in-flight initiatives, expected and realised benefit.
- Define consistent baseline, measurement and ownership so benefits are
  credible, visible and repeatable.

### 5. Capability, adoption and change
- Raise AI literacy and automation awareness across GBS functions.
- Build capability through playbooks, use-case libraries, training and
  communities of practice.
- Move promising emerging technology from proof of concept to scaled deployment.

## Scope
- **Functions:** all GBS functions — Finance, HRSS, IT, Supply Chain,
  Commercial, Pricing, FP&A and other shared-service areas.
- **Capabilities:** AI / GenAI, automation, RPA, process mining, Celonis,
  low-code / no-code, SaaS enablement, analytics, value realisation.
- **Geography:** Hyderabad anchor, playbooks scalable to all GBS sites.
- **Stakeholders:** GBS leadership, functional leaders, Group AI, IT,
  enterprise architecture, transformation, platform and process owners.

## Required experience and capabilities
- Strong experience in shared services / GBS, digital transformation,
  automation, AI adoption or technology-enabled productivity programmes.
- Demonstrated ability to build and run enterprise-level automation portfolios,
  productivity pipelines, business cases and value-realisation mechanisms.
- Working knowledge of RPA, Celonis / process mining, AI / GenAI, low-code /
  no-code, analytics, workflow tools and SaaS platforms.
- Ability to align senior business stakeholders, IT, enterprise architecture
  and delivery teams, and remove execution barriers.
- Strong programme governance, portfolio management, financial value tracking,
  change management and executive-reporting skills.

## Key skills
- Celonis and process-mining expertise, including standing up a Celonis-led CoE.
- RPA across opportunity assessment, bot delivery, governance and sustainment.
- Scaling AI COE capability — use-case identification, governance, adoption,
  controls and value realisation.
- SAP experience and the ability to spot automation opportunity in SAP-enabled
  process estates.
- GBS / shared-services experience: service delivery models, process ownership,
  operational metrics and productivity levers.

## Qualifications
- Bachelor's degree in Engineering, Technology, Finance, Business or Operations;
  MBA or equivalent postgraduate qualification preferred.
- Certifications in Celonis, process mining, RPA, Lean Six Sigma, Agile or
  programme management are an advantage.
- Leadership experience in GBS, shared services, business transformation,
  digital operations or process excellence, in global matrixed environments.

## Success measures
- Annual automation-enabled productivity delivered across GBS — savings, cost
  avoidance and capacity release.
- Size, quality and conversion rate of the automation opportunity pipeline.
- Reduction in automation delivery cycle time.
- Adoption of AI, automation, process mining and reusable digital solutions.
- Governance compliance, architecture alignment and visibility of automation ROI.

## Logistics
- Location: Hyderabad, India. Reports to the Head of GBS.
`,
  },
  {
    key: "transformation-ci-manager",
    index: 7,
    title: "Transformation & Continuous Improvement Manager",
    slug: "solenis-hyd-transformation-ci-manager",
    bandKey: "IN14",
    jobFunction: "Transformation & Productivity",
    hiringManagerName: "Head of GBS Transformation",
    seniority: "mid",
    openings: 1,
    status: "posted",
    skills: [
      "Lean Six Sigma",
      "Process Mapping",
      "Project Management (PMO)",
      "Power BI",
      "Change Management",
    ],
    summary:
      "Executes GBS transformation initiatives, process improvement and benefits tracking. Reports to the Head of GBS Transformation.",
    jdText: `# Transformation & Continuous Improvement Manager — Solenis GBS India

## Job summary
Supports the delivery of GBS transformation initiatives by driving process
improvement projects, coordinating transformation programmes, tracking benefits
realisation and enabling adoption of digital and automation solutions. Works
closely with Global Process Owners, functional leaders, GBS operations teams and
transformation leads to execute strategic transformation priorities and foster a
culture of continuous improvement.

## Key responsibilities
### 1. Transformation programme execution
- Support execution of GBS transformation initiatives and workstreams.
- Coordinate project plans, timelines, milestones and deliverables across functions.
- Monitor progress; escalate risks, issues and dependencies.
- Prepare status reports, dashboards and leadership updates.

### 2. Process excellence and continuous improvement
- Identify process improvement opportunities across Finance, HR, Procurement,
  Customer Service, IT and other GBS functions.
- Facilitate Lean and continuous-improvement workshops.
- Run process mapping, root-cause analysis and waste-elimination exercises.
- Support standardisation and best-practice deployment across locations.

### 3. Digital and automation enablement
- Partner with business teams to identify automation and productivity opportunities.
- Support implementation of workflow, RPA, AI, analytics and self-service initiatives.
- Track automation benefits and adoption metrics.
- Maintain the transformation opportunity pipeline and benefit trackers.

### 4. Change management and adoption
- Support communication and change-management activity.
- Develop training material, user guides and adoption plans.
- Coordinate stakeholder engagement workshops and feedback sessions.
- Monitor adoption, compliance and sustainability of implemented solutions.

### 5. Governance and PMO support
- Maintain transformation governance routines and action trackers.
- Support Steering Committee and leadership review material.
- Track project KPIs, SLAs, milestones and benefits realisation.
- Ensure compliance with project-management standards and methodologies.

### 6. Analytics and value realisation
- Develop productivity dashboards and performance reporting.
- Analyse operational data to identify trends and improvement opportunities.
- Support business-case development and ROI calculation.
- Measure realised savings, productivity gains and service improvement.

## Key stakeholders
GBS functional leaders; Global Process Owners; operations managers; IT, data and
analytics teams; the Transformation Office; business process owners; external
technology partners.

## Required qualifications and experience
- Bachelor's degree in Business, Engineering, Finance, Operations or Information
  Systems. MBA preferred but not required.
- 5–8 years in GBS, shared services, process excellence, PMO, operations
  excellence, consulting or transformation roles.
- Experience supporting business process improvement initiatives.
- Exposure to digital transformation, automation or productivity programmes.
- Experience in matrixed, global environments preferred.

## Preferred certifications
Lean Six Sigma Green Belt; PMP or CAPM; Agile / Scrum fundamentals; Prosci or
change-management foundations; Power BI, Celonis or Power Platform certifications.

## Key skills and competencies
- **Technical:** process mapping and improvement; project management / PMO;
  business analytics and reporting; automation opportunity assessment;
  Power BI / Excel / dashboarding; continuous-improvement methodologies.
- **Behavioural:** strong analytical and problem-solving skills; effective
  communication and stakeholder management; organised and detail-oriented;
  collaborative; proactive and results-driven; continuous-learning mindset.

## Success measures
Productivity opportunities identified and implemented; transformation projects
delivered on time and in scope; benefits realised against approved business
cases; improvement in operational KPIs and service levels; stakeholder
satisfaction and adoption; number of CI projects completed.

## Career progression
Program & Transformation Lead (8–15 yrs) → Head of Transformation / GBS Excellence.

${gbsLogistics("IN14", "the Head of GBS Transformation")}`,
  },
  {
    key: "program-transformation-lead",
    index: 8,
    title: "Program & Transformation Lead",
    slug: "solenis-hyd-program-transformation-lead",
    bandKey: "LEAD",
    jobFunction: "Transformation & Productivity",
    hiringManagerName: "Head of GBS",
    seniority: "senior",
    openings: 1,
    status: "pending_approval",
    skills: [
      "GBS Operating Model Design",
      "Lean Six Sigma Black Belt",
      "Program & Portfolio Management",
      "Digital Transformation",
      "Executive Stakeholder Management",
    ],
    summary:
      "Owns the GBS transformation vision, multi-year roadmap and enterprise programme delivery. Reports to the Head of GBS.",
    jdText: `# Program & Transformation Lead — Solenis GBS India

## Job description summary
Designs and implements programmes that supply the organisation with trained
executives in accordance with the organisation's plans and strategies. Consults
with management on the planning, development, implementation and evaluation of
management training programmes, and coordinates programmes in management
appraisal, counselling, promotion and placement.

## Key responsibilities
### 1. Transformation strategy and roadmap
- Design and execute the GBS transformation vision and multi-year roadmap,
  aligned with enterprise and functional strategies.
- Identify and prioritise transformation opportunities across processes,
  geographies and service lines.
- Build strong business cases with clear value realisation — cost, productivity,
  service levels, risk reduction.

### 2. Process excellence and operating model
- Lead end-to-end process re-engineering and standardisation (Lean, Six Sigma,
  Design Thinking).
- Drive adoption of best-in-class GBS operating models — global process
  ownership, tiered service delivery, COEs.
- Establish and track KPIs, SLAs and outcome-based performance measures.

### 3. Digital and automation enablement
- Identify and implement automation and digital solutions — RPA, workflow,
  AI / ML, analytics, self-service.
- Partner with IT, Digital and external vendors to deliver scalable, secure,
  technology-enabled solutions.
- Drive the intelligent-automation pipeline and benefits realisation.

### 4. Change management and stakeholder engagement
- Lead enterprise-wide change management: communication, training, adoption.
- Act as a trusted advisor to senior leaders and global stakeholders.
- Influence without authority across functions and regions.

### 5. Governance and programme management
- Establish robust transformation governance, cadence and reporting.
- Manage multiple transformation programmes simultaneously with disciplined
  execution and risk mitigation.
- Track benefits realisation and ensure post-implementation value sustainment.

### 6. Capability building and culture
- Embed a continuous-improvement and transformation mindset in GBS teams.
- Coach and mentor process owners, transformation managers and CI practitioners.
- Contribute to GBS maturity-model advancement.

## Key stakeholders
Global Process Owners; function leaders (Finance, HR, Procurement, IT); GBS
leadership and country heads; IT, digital, data and analytics teams; external
partners and technology vendors.

## Required qualifications and experience
- Bachelor's degree required; MBA or equivalent preferred.
- 8–15+ years in GBS, shared services, consulting or transformation roles.
- Proven track record delivering large-scale global transformations.
- Strong exposure to process excellence, digital transformation and operating
  model redesign.
- Experience working across cultures and global locations.

## Certifications (preferred)
Lean Six Sigma Black Belt / Green Belt; PMP / PRINCE2 / SAFe; change management
(Prosci, ADKAR); RPA or digital-transformation certifications.

## Key skills and competencies
- **Technical / functional:** GBS and shared-services design; process
  re-engineering and optimisation; automation and digital transformation;
  data-driven decision-making and analytics; programme and portfolio management.
- **Behavioural:** strategic thinking and problem-solving; strong executive
  communication and storytelling; stakeholder influence and collaboration; high
  learning agility and resilience; results-oriented with a hands-on mindset.

## Success measures
Transformation benefits realised (cost, productivity, quality); adoption and
sustainability of new processes and technologies; GBS maturity improvement and
stakeholder satisfaction; speed and effectiveness of transformation delivery.

## Logistics
- Location: Hyderabad, India. Reports to the Head of GBS.
`,
  },
];

const ROLE_TITLES = ROLES.map((r) => r.title);

// ─────────────────────────── 6. market benchmarks ───────────────────────────

type Level = "low" | "medium" | "high";

interface BenchmarkSeed {
  roleTitle: string;
  medianLpa: number;
  ttfDays: number;
  availability: Level;
  competitorDemand: Level;
  recommendedRounds: number;
  trendingSkills: string[];
}

const BENCHMARK_SOURCE_NOTE = "Curated benchmark — Solenis GBS pilot, update quarterly";

/**
 * One row per Solenis role. Medians sit near their band mid; time-to-fill scales
 * with seniority. Availability / competitor demand are set so the SDL Head reads
 * as visibly hard to fill (low availability, high demand, 75 days) and Accounting
 * Assistant III as easy (high availability, low demand, 35 days).
 */
const BENCHMARKS: BenchmarkSeed[] = [
  {
    roleTitle: "Accounting Assistant III",
    medianLpa: 7.5,
    ttfDays: 35,
    availability: "high",
    competitorDemand: "low",
    recommendedRounds: 2,
    trendingSkills: ["SAP FI", "Accounts Payable", "Reconciliations", "Advanced Excel"],
  },
  {
    roleTitle: "Business Coordinator",
    medianLpa: 24,
    ttfDays: 50,
    availability: "medium",
    competitorDemand: "medium",
    recommendedRounds: 2,
    trendingSkills: ["SAP SD", "Order Management", "Master Data", "Stakeholder Management"],
  },
  {
    roleTitle: "SAP Plant Accountant",
    medianLpa: 16,
    ttfDays: 58,
    availability: "low",
    competitorDemand: "high",
    recommendedRounds: 2,
    trendingSkills: ["SAP FI/CO", "Product Costing", "Material Ledger", "Inventory Valuation"],
  },
  {
    roleTitle: "Tableau Analyst",
    medianLpa: 15,
    ttfDays: 45,
    availability: "medium",
    competitorDemand: "high",
    recommendedRounds: 2,
    trendingSkills: ["Tableau", "SQL", "Alteryx", "Snowflake"],
  },
  {
    roleTitle: "Non-SAP Plant Accountant",
    medianLpa: 14,
    ttfDays: 42,
    availability: "medium",
    competitorDemand: "medium",
    recommendedRounds: 2,
    trendingSkills: ["Cost Accounting", "Month-End Close", "Internal Controls", "Advanced Excel"],
  },
  {
    roleTitle: "SDL / Head – Automation and Productivity (GBS)",
    medianLpa: 55,
    ttfDays: 75,
    availability: "low",
    competitorDemand: "high",
    recommendedRounds: 3,
    trendingSkills: ["Celonis", "GenAI adoption", "Automation CoE", "Value realisation"],
  },
  {
    roleTitle: "Transformation & Continuous Improvement Manager",
    medianLpa: 24,
    ttfDays: 55,
    availability: "medium",
    competitorDemand: "high",
    recommendedRounds: 3,
    trendingSkills: ["Lean Six Sigma", "Process mining", "Benefits tracking", "Power BI"],
  },
  {
    roleTitle: "Program & Transformation Lead",
    medianLpa: 52,
    ttfDays: 70,
    availability: "low",
    competitorDemand: "high",
    recommendedRounds: 3,
    trendingSkills: [
      "GBS operating model",
      "Global process ownership",
      "Portfolio management",
      "Change management",
    ],
  },
];

/**
 * The generic tech benchmark rows seed-benchmarks.ts ships. REMOVED for this
 * tenant: a GBS finance client whose Market Intelligence table opens on "DevOps
 * Engineer" is looking at somebody else's product. Named explicitly rather than
 * a blanket `NOT IN (ours)` so the delete can never take a row we did not mean.
 */
const GENERIC_BENCHMARK_TITLES = [
  "Senior Backend Engineer",
  "Staff Frontend Engineer",
  "Senior Frontend Engineer",
  "Data Platform Engineer",
  "Product Designer",
  "Engineering Manager, Platform",
  "Senior Data Scientist",
  "Principal Site Reliability Engineer",
  "Backend Engineer",
  "DevOps Engineer",
];

// ─────────────────────────── 7. approval routing ───────────────────────────
//
// THEIR CHAIN: HR → Hiring Manager → Skip Level → GSS Leader, with the Global
// Function Lead joining for offers and senior roles.
//
// WHAT THE MODEL CAN EXPRESS: approval_matrices carries exactly ONE approver
// step (T1.3 option (b) — a second step is silently ignored by the decision
// spine), and APPROVAL_MATRIX_APPROVER_ROLES constrains the approver to
// {hr_head, admin} because those are the only roles the decision procedures
// accept. So the multi-stage chain CANNOT be routed. What we do instead:
// encode the real chain in the policy NAME (which is what /admin/approval-routing
// renders) and in rules.chain_note, and route the single enforced decision to
// hr_head. See the hand-back "not expressible" list.
interface MatrixSeed {
  id: string;
  subjectType: "requisition" | "offer";
  name: string;
  approverRef: "hr_head" | "admin";
  chainNote: string;
}

const MATRICES: MatrixSeed[] = [
  {
    id: mkId(KIND.approvalMatrix, 1),
    subjectType: "requisition",
    name: "Requisition — HR → Hiring Manager → Skip Level → GSS Leader",
    approverRef: "hr_head",
    chainNote:
      "Solenis chain: HR → Hiring Manager → Skip Level → GSS Leader. The platform " +
      "enforces ONE approver step (hr_head); the preceding steps are governed off-platform.",
  },
  {
    id: mkId(KIND.approvalMatrix, 2),
    subjectType: "offer",
    name: "Offer — HR → HM → Skip Level → GSS Leader → Global Function Lead",
    approverRef: "hr_head",
    chainNote:
      "Solenis chain for offers and senior roles adds the Global Function Lead after " +
      "the GSS Leader. The platform enforces ONE approver step (hr_head); the " +
      "preceding steps are governed off-platform.",
  },
];

/** Active from before today so these win the resolver's ORDER BY effective_from
 * DESC over the generic t13 / SEED-02 matrices already on the tenant. */
const MATRIX_EFFECTIVE_FROM = "2026-08-01T00:00:00Z";

// ─────────────────────────── 8. interview templates ───────────────────────────
//
// Criteria are verbatim from their rating sheet (1–5 scale, which is the
// platform's fixed scorecard scale — see interview_feedback.scorecard).
const SCORECARD_PEOPLE = {
  id: mkId(KIND.scorecard, 1),
  key: "solenis_people_competencies",
  label: "Solenis people competencies",
  criteria: [
    { key: "people_developer", label: "People Developer" },
    { key: "inclusive_leader", label: "Inclusive Leader" },
    { key: "change_catalyst", label: "Change Catalyst" },
    { key: "creative_thinking", label: "Creative Thinking" },
    { key: "effective_communication", label: "Effective Communication" },
    { key: "strategic_visionary", label: "Strategic Visionary" },
  ],
};

const SCORECARD_FUNCTIONAL = {
  id: mkId(KIND.scorecard, 2),
  key: "solenis_functional",
  label: "Solenis functional assessment",
  criteria: [
    { key: "domain_knowledge", label: "Domain Knowledge" },
    { key: "problem_solving", label: "Problem Solving" },
    { key: "tool_expertise", label: "Tool Expertise" },
  ],
};

interface RoundSeed {
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  mode: "video" | "onsite" | "phone";
  scorecardKey: string;
  competencyFocus: string[];
}

/** Their SENIOR loop (3 rounds). tenant_interview_round_template is unique on
 * (tenant_id, round_number) — ONE tenant-wide default loop, so the senior loop
 * is the tenant default and the JUNIOR 2-round loop is expressed per-requisition
 * in interview_plans (rounds 1–2 of the same list). */
const SENIOR_ROUNDS: RoundSeed[] = [
  {
    roundNumber: 1,
    roundName: "Hiring Manager Round",
    durationMinutes: 60,
    mode: "video",
    scorecardKey: SCORECARD_FUNCTIONAL.key,
    competencyFocus: ["domain_knowledge", "problem_solving", "tool_expertise"],
  },
  {
    roundNumber: 2,
    roundName: "Function Head + Centre Head & HR",
    durationMinutes: 60,
    mode: "onsite",
    scorecardKey: SCORECARD_PEOPLE.key,
    competencyFocus: ["effective_communication", "change_catalyst", "inclusive_leader"],
  },
  {
    roundNumber: 3,
    roundName: "Global Shared Services Leader Round",
    durationMinutes: 45,
    mode: "video",
    scorecardKey: SCORECARD_PEOPLE.key,
    competencyFocus: ["strategic_visionary", "people_developer", "creative_thinking"],
  },
];

/** The junior loop is the first two rounds of the same structure. */
const JUNIOR_ROUNDS: RoundSeed[] = SENIOR_ROUNDS.slice(0, 2);

// ─────────────────────────── 9. sourcing channels ───────────────────────────
//
// tenant_application_sources is keyed on the FIXED `application_source` enum, so
// a channel only exists if the enum has a slot for it. Their five channels map:
//   job boards      → job_board
//   referral        → referral
//   agency (Hudson) → partner_empanelled
//   careers site    → career_site
//   internal        → talent_pool   ← nearest available slot; there is no
//                                     `internal_mobility` enum value (noted).
interface SourceSeed {
  sourceEnum: string;
  label: string;
  enabled: boolean;
  ingestionMode: "manual" | "connector_pending";
  notes: string;
}

const SOURCE_CHANNELS: SourceSeed[] = [
  {
    sourceEnum: "job_board",
    label: "Naukri (job board)",
    enabled: true,
    ingestionMode: "connector_pending",
    notes: "Primary channel (~40% of Solenis GBS applications). Automated ingestion is a connector work package.",
  },
  {
    sourceEnum: "referral",
    label: "Employee referral",
    enabled: true,
    ingestionMode: "manual",
    notes: "~30% of Solenis GBS applications.",
  },
  {
    sourceEnum: "partner_empanelled",
    label: "Agency — Hudson",
    enabled: true,
    ingestionMode: "manual",
    notes: "~10% of applications. Empanelled agency submitting via the partner portal.",
  },
  {
    sourceEnum: "career_site",
    label: "Careers site",
    enabled: true,
    ingestionMode: "manual",
    notes: "~10% of applications. Public apply form on the branded careers page.",
  },
  {
    sourceEnum: "talent_pool",
    label: "Internal mobility",
    enabled: true,
    ingestionMode: "manual",
    notes:
      "~10% of applications. Mapped onto the `talent_pool` source enum — the enum has no " +
      "internal_mobility value, so this is the nearest honest slot.",
  },
];

// ─────────────────────────── 10. partner org Hudson ───────────────────────────

const HUDSON_ORG = mkId(KIND.partnerOrg, 1);
const HUDSON_MSA = mkId(KIND.partnerMsa, 1);
const HUDSON_NAME = "Hudson";
const HUDSON_CONTACT = "gbs.india@hudson-partners.test";

// ─────────────────────────── 12. document types ───────────────────────────
//
// document_types is a tenant-AGNOSTIC reference table (no tenant_id) keyed on
// `code`. Aadhaar Card / PAN Card / Education Certificate already ship in the
// migration seed; these are the ones from their joining-document list that do not.
interface DocTypeSeed {
  n: number;
  code: string;
  name: string;
  geographyCode: string | null;
  retentionYears: number;
}

const DOC_TYPES: DocTypeSeed[] = [
  { n: 1, code: "passport_photo", name: "Passport Photo", geographyCode: null, retentionYears: 7 },
  { n: 2, code: "bank_statement", name: "Bank Statement", geographyCode: null, retentionYears: 7 },
  {
    n: 3,
    code: "uan_service_history",
    name: "UAN Service History",
    geographyCode: "IN",
    retentionYears: 8,
  },
  {
    n: 4,
    code: "pf_passbook_previous",
    name: "PF Passbook (Previous Employer)",
    geographyCode: "IN",
    retentionYears: 8,
  },
  {
    n: 5,
    code: "pf_passbook_latest",
    name: "PF Passbook (Latest Employer)",
    geographyCode: "IN",
    retentionYears: 8,
  },
];

const DOC_TYPE_CODES = DOC_TYPES.map((d) => d.code);

// ─────────────────────────── 11. pipeline ───────────────────────────

type Stage =
  | "application_received"
  | "ai_screening"
  | "recruiter_review"
  | "shortlisted"
  | "tech_interview"
  | "hr_round"
  | "offer_drafted";

/** The happy path, in order — the transition chain walks a prefix of this. */
const STAGE_PATH: Stage[] = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
];

interface AppSeed {
  roleKey: string;
  fullName: string;
  stage: Stage;
  /** How long the candidate has sat in `stage`, in hours. Chosen against the
   * RESOLVED thresholds (application_received 48, ai_screening 1,
   * recruiter_review 72, shortlisted 24, tech_interview 72, hr_round 48,
   * offer_drafted 120) so the ageing views show healthy AND breaching rows. */
  ageHours: number;
  /** Candidate expectation in LPA. */
  expectedLpa: number;
  source: "job_board" | "referral" | "partner_empanelled" | "career_site" | "talent_pool";
  yearsExperience: number;
}

/**
 * 34 applications. Source mix ≈ their stated split (job board 40 / referral 30 /
 * agency 10 / careers 10 / internal 10): 14 / 10 / 3 / 4 / 3.
 *
 * Comp: expectations sit around the band mid, EXCEPT Vikram Reddy on the IN12
 * SAP Plant Accountant at ₹21 LPA — deliberately above the IN12 ceiling (₹18
 * LPA) so the comp desk renders the NEED_APPROVAL verdict.
 */
const APPLICATIONS: AppSeed[] = [
  // ── Accounting Assistant III (IN09, 6–9 LPA, mid 7.5) — the easy-to-fill role
  { roleKey: "accounting-assistant-iii", fullName: "Sneha Rathi", stage: "offer_drafted", ageHours: 30, expectedLpa: 8.2, source: "referral", yearsExperience: 4 },
  { roleKey: "accounting-assistant-iii", fullName: "Manoj Kulkarni", stage: "hr_round", ageHours: 62, expectedLpa: 7.6, source: "job_board", yearsExperience: 5 },
  { roleKey: "accounting-assistant-iii", fullName: "Divya Prasad", stage: "tech_interview", ageHours: 40, expectedLpa: 7.0, source: "job_board", yearsExperience: 3 },
  { roleKey: "accounting-assistant-iii", fullName: "Arjun Nair", stage: "shortlisted", ageHours: 8, expectedLpa: 6.8, source: "career_site", yearsExperience: 3 },
  { roleKey: "accounting-assistant-iii", fullName: "Pooja Deshmukh", stage: "recruiter_review", ageHours: 96, expectedLpa: 7.2, source: "referral", yearsExperience: 4 },
  { roleKey: "accounting-assistant-iii", fullName: "Harish Bandaru", stage: "application_received", ageHours: 12, expectedLpa: 6.5, source: "job_board", yearsExperience: 2 },

  // ── Business Coordinator (IN14, 20–28 LPA, mid 24)
  { roleKey: "business-coordinator", fullName: "Lakshmi Venkatesh", stage: "hr_round", ageHours: 20, expectedLpa: 25.5, source: "referral", yearsExperience: 9 },
  { roleKey: "business-coordinator", fullName: "Imran Sheikh", stage: "tech_interview", ageHours: 88, expectedLpa: 24.0, source: "job_board", yearsExperience: 8 },
  { roleKey: "business-coordinator", fullName: "Nandini Rao", stage: "recruiter_review", ageHours: 30, expectedLpa: 22.5, source: "partner_empanelled", yearsExperience: 7 },
  { roleKey: "business-coordinator", fullName: "Sridhar Gollapudi", stage: "application_received", ageHours: 60, expectedLpa: 26.0, source: "job_board", yearsExperience: 10 },

  // ── SAP Plant Accountant (IN12, 12–18 LPA, mid 15)
  { roleKey: "sap-plant-accountant", fullName: "Vikram Reddy", stage: "offer_drafted", ageHours: 140, expectedLpa: 21.0, source: "referral", yearsExperience: 9 },
  { roleKey: "sap-plant-accountant", fullName: "Anita Joshi", stage: "hr_round", ageHours: 26, expectedLpa: 16.5, source: "job_board", yearsExperience: 8 },
  { roleKey: "sap-plant-accountant", fullName: "Karthik Subramanian", stage: "tech_interview", ageHours: 96, expectedLpa: 15.0, source: "job_board", yearsExperience: 7 },
  { roleKey: "sap-plant-accountant", fullName: "Rakesh Patnaik", stage: "shortlisted", ageHours: 16, expectedLpa: 14.2, source: "talent_pool", yearsExperience: 6 },
  { roleKey: "sap-plant-accountant", fullName: "Bhavana Chidambaram", stage: "recruiter_review", ageHours: 44, expectedLpa: 13.5, source: "career_site", yearsExperience: 6 },

  // ── Tableau Analyst (IN12, 12–18 LPA, mid 15)
  { roleKey: "tableau-analyst", fullName: "Rohit Malhotra", stage: "hr_round", ageHours: 54, expectedLpa: 17.0, source: "job_board", yearsExperience: 7 },
  { roleKey: "tableau-analyst", fullName: "Swetha Mudumba", stage: "tech_interview", ageHours: 22, expectedLpa: 15.5, source: "referral", yearsExperience: 6 },
  { roleKey: "tableau-analyst", fullName: "Faisal Ahmed", stage: "shortlisted", ageHours: 34, expectedLpa: 14.0, source: "job_board", yearsExperience: 5 },
  { roleKey: "tableau-analyst", fullName: "Priyanka Sahoo", stage: "ai_screening", ageHours: 0.3, expectedLpa: 13.8, source: "career_site", yearsExperience: 4 },
  { roleKey: "tableau-analyst", fullName: "Naveen Chowdary", stage: "application_received", ageHours: 70, expectedLpa: 16.2, source: "partner_empanelled", yearsExperience: 8 },

  // ── Non-SAP Plant Accountant (IN12, filled)
  { roleKey: "non-sap-plant-accountant", fullName: "Meenakshi Iyer", stage: "offer_drafted", ageHours: 48, expectedLpa: 15.8, source: "referral", yearsExperience: 8 },
  { roleKey: "non-sap-plant-accountant", fullName: "Gopal Krishnan", stage: "hr_round", ageHours: 36, expectedLpa: 14.5, source: "job_board", yearsExperience: 7 },
  { roleKey: "non-sap-plant-accountant", fullName: "Shalini Bhatt", stage: "tech_interview", ageHours: 12, expectedLpa: 13.9, source: "talent_pool", yearsExperience: 6 },
  { roleKey: "non-sap-plant-accountant", fullName: "Aravind Sastry", stage: "recruiter_review", ageHours: 80, expectedLpa: 13.0, source: "referral", yearsExperience: 6 },

  // ── SDL / Head – Automation and Productivity (Leadership, 45–65 LPA, mid 55)
  { roleKey: "sdl-head-automation", fullName: "Ramesh Iyengar", stage: "hr_round", ageHours: 70, expectedLpa: 58.0, source: "job_board", yearsExperience: 18 },
  { roleKey: "sdl-head-automation", fullName: "Deepa Varadarajan", stage: "tech_interview", ageHours: 30, expectedLpa: 54.0, source: "referral", yearsExperience: 16 },
  { roleKey: "sdl-head-automation", fullName: "Ajay Kaushik", stage: "recruiter_review", ageHours: 110, expectedLpa: 61.0, source: "partner_empanelled", yearsExperience: 20 },

  // ── Transformation & CI Manager (IN14, 20–28 LPA, mid 24)
  { roleKey: "transformation-ci-manager", fullName: "Sanjana Kapoor", stage: "shortlisted", ageHours: 18, expectedLpa: 25.0, source: "job_board", yearsExperience: 8 },
  { roleKey: "transformation-ci-manager", fullName: "Prashant Bhosale", stage: "recruiter_review", ageHours: 52, expectedLpa: 23.0, source: "referral", yearsExperience: 7 },
  { roleKey: "transformation-ci-manager", fullName: "Ritika Sen", stage: "ai_screening", ageHours: 0.6, expectedLpa: 22.0, source: "career_site", yearsExperience: 6 },
  { roleKey: "transformation-ci-manager", fullName: "Vivek Dandekar", stage: "application_received", ageHours: 26, expectedLpa: 26.5, source: "job_board", yearsExperience: 9 },

  // ── Program & Transformation Lead (Leadership, 45–65 LPA, mid 55)
  { roleKey: "program-transformation-lead", fullName: "Sundar Ramanathan", stage: "tech_interview", ageHours: 100, expectedLpa: 57.0, source: "job_board", yearsExperience: 17 },
  { roleKey: "program-transformation-lead", fullName: "Nithya Balasubramanian", stage: "recruiter_review", ageHours: 24, expectedLpa: 52.0, source: "referral", yearsExperience: 14 },
  { roleKey: "program-transformation-lead", fullName: "Zubin Contractor", stage: "application_received", ageHours: 55, expectedLpa: 60.0, source: "talent_pool", yearsExperience: 19 },
];

/** AI score band per stage — later stages score higher (stage-appropriate; the
 * two earliest stages carry no score, matching the real pipeline where scoring
 * has not run or has only just been enqueued). */
const STAGE_SCORES: Record<Stage, number[] | null> = {
  application_received: null,
  ai_screening: null,
  recruiter_review: [62, 66, 69, 71],
  shortlisted: [74, 77, 79],
  tech_interview: [80, 82, 84, 86],
  hr_round: [85, 87, 89],
  offer_drafted: [88, 90, 92],
};

// ───────────────────────────────── main ─────────────────────────────────

type SqlClient = (typeof import("../client"))["sql"];

async function main(): Promise<void> {
  const undo = process.argv.includes("--undo");

  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes(REQUIRED_DB_HOST_FRAGMENT)) {
    console.error(
      `REFUSING TO RUN: DATABASE_URL does not name the Solenis project ` +
        `(expected host fragment "${REQUIRED_DB_HOST_FRAGMENT}").\n` +
        `The repo-root .env points at the OLD staging database — export the ` +
        `Solenis env before running this seed.`,
    );
    process.exit(2);
  }

  const { sql } = await import("../client");

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
      await runUndo(sql, tid);
      return;
    }

    console.log(`Seeding the Solenis GBS demo mapping into ${TENANT_SLUG} (${tid})\n`);

    // ── memberships ────────────────────────────────────────────────────────
    async function membershipByEmail(email: string): Promise<string | null> {
      const [m] = await sql<{ id: string }[]>`
        SELECT tum.id FROM public.tenant_user_memberships tum
        JOIN auth.users au ON au.id = tum.user_id
        WHERE tum.tenant_id = ${tid} AND tum.status = 'active' AND au.email = ${email}
        LIMIT 1
      `;
      return m?.id ?? null;
    }
    const recruiterId = await membershipByEmail(RECRUITER_EMAIL);
    const hiringManagerId = await membershipByEmail(HIRING_MANAGER_EMAIL);
    const hrHeadId = await membershipByEmail(HR_HEAD_EMAIL);
    const panelId = await membershipByEmail(PANEL_EMAIL);
    const adminId = await membershipByEmail(ADMIN_EMAIL);
    if (!recruiterId || !hiringManagerId || !hrHeadId || !panelId || !adminId) {
      console.error(
        "Missing one of recruiter1 / hiringmanager1 / hrhead1 / panel1 / admin1 in " +
          `${TENANT_SLUG}. Run pnpm db:seed:test-users first.`,
      );
      process.exit(2);
    }

    // ── 1 + 2. tenant identity, branding, SLA thresholds ───────────────────
    //
    // Two atomic top-level jsonb `||` merges, exactly as updateTenantBranding /
    // updateSlaThresholds write them: `settings` keeps every sibling key
    // (locale, currency, timezone, aiSettings, …) verbatim.
    await sql`
      UPDATE public.tenants
         SET display_name = ${TENANT_DISPLAY_NAME},
             settings = COALESCE(settings, '{}'::jsonb)
                        || jsonb_build_object('branding', ${JSON.stringify(BRANDING)}::jsonb)
       WHERE id = ${tid}
    `;
    await sql`
      UPDATE public.tenants
         SET settings = COALESCE(settings, '{}'::jsonb)
                        || jsonb_build_object('slaThresholds', ${JSON.stringify(SLA_THRESHOLDS)}::jsonb)
       WHERE id = ${tid}
    `;
    console.log(`  ✓ tenant identity → "${TENANT_DISPLAY_NAME}" + branding ${BRANDING.primaryColor}`);
    console.log(
      `  ✓ SLA thresholds → application_received ${SLA_THRESHOLDS.application_received}h, ` +
        `recruiter_review ${SLA_THRESHOLDS.recruiter_review}h, ` +
        `offer_drafted ${SLA_THRESHOLDS.offer_drafted}h (others left at defaults)`,
    );

    // ── 3. comp bands ──────────────────────────────────────────────────────
    for (const b of BANDS) {
      await sql`
        INSERT INTO public.comp_bands
          (id, tenant_id, name, level, currency, min_major, max_major, is_archived, updated_at)
        VALUES (${b.id}, ${tid}, ${b.name}, ${b.level}, 'INR',
                ${lpaToRupees(b.minLpa)}::numeric, ${lpaToRupees(b.maxLpa)}::numeric, false, now())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, level = EXCLUDED.level, currency = EXCLUDED.currency,
          min_major = EXCLUDED.min_major, max_major = EXCLUDED.max_major,
          is_archived = false, updated_at = now()
      `;
    }
    console.log(`  ✓ ${BANDS.length} comp bands (IN09 / IN12 / IN14 / Leadership, MAJOR INR)`);

    // ── 4. business unit + headcount envelope ──────────────────────────────
    await sql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${SOLENIS_BU}, ${tid}, ${SOLENIS_BU_NAME}, ${SOLENIS_BU_SLUG})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
    `;
    const totalOpenings = ROLES.reduce((a, r) => a + r.openings, 0);
    await sql`
      INSERT INTO public.headcount_envelopes
        (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount,
         status, notes)
      VALUES (${SOLENIS_ENVELOPE}, ${tid}, ${SOLENIS_BU},
              date_trunc('year', now())::date,
              (date_trunc('year', now()) + interval '1 year' - interval '1 day')::date,
              ${totalOpenings + 4}, 'approved',
              'Solenis GBS India FY headcount envelope (demo).')
      ON CONFLICT (id) DO UPDATE SET
        planned_headcount = EXCLUDED.planned_headcount, status = 'approved', updated_at = now()
    `;
    console.log(`  ✓ business unit "${SOLENIS_BU_NAME}" + FY headcount envelope`);

    // ── 5. positions / JDs / requisitions / plans ───────────────────────────
    let skillN = 0;
    let planN = 0;
    for (const role of ROLES) {
      const b = band(role.bandKey);
      const positionId = mkId(KIND.position, role.index);
      const jdId = mkId(KIND.jdVersion, role.index);
      const reqId = mkId(KIND.requisition, role.index);

      await sql`
        INSERT INTO public.positions
          (id, tenant_id, business_unit_id, title, level, "function", location_type,
           primary_location, comp_band_min, comp_band_max, comp_currency, comp_band_id,
           hiring_manager_id, is_active, updated_at)
        VALUES (${positionId}, ${tid}, ${SOLENIS_BU}, ${role.title}, ${b.level},
                ${role.jobFunction}, 'hybrid', ${HYDERABAD},
                ${lpaToRupees(b.minLpa)}::numeric, ${lpaToRupees(b.maxLpa)}::numeric, 'INR',
                ${b.id}, ${hiringManagerId}, true, now())
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, level = EXCLUDED.level, "function" = EXCLUDED."function",
          primary_location = EXCLUDED.primary_location,
          comp_band_min = EXCLUDED.comp_band_min, comp_band_max = EXCLUDED.comp_band_max,
          comp_currency = EXCLUDED.comp_currency, comp_band_id = EXCLUDED.comp_band_id,
          hiring_manager_id = EXCLUDED.hiring_manager_id, is_active = true, updated_at = now()
      `;

      await sql`
        INSERT INTO public.jd_versions
          (id, tenant_id, position_id, version_number, status, jd_text, summary,
           approved_by, approved_at, updated_at)
        VALUES (${jdId}, ${tid}, ${positionId}, 1, 'approved', ${role.jdText}, ${role.summary},
                ${hrHeadId}, now() - interval '20 days', now())
        ON CONFLICT (id) DO UPDATE SET
          jd_text = EXCLUDED.jd_text, summary = EXCLUDED.summary,
          status = 'approved', updated_at = now()
      `;

      // jd_skills has no natural unique key (PK on id only), so a
      // "ON CONFLICT DO NOTHING" insert with a random id duplicates on every
      // run. Deterministic ids make this genuinely idempotent.
      for (const skill of role.skills) {
        await sql`
          INSERT INTO public.jd_skills
            (id, tenant_id, jd_version_id, skill_name, weight, is_required)
          VALUES (${mkId(KIND.jdSkill, skillN++)}, ${tid}, ${jdId}, ${skill}, 1.00, true)
          ON CONFLICT (id) DO UPDATE SET
            skill_name = EXCLUDED.skill_name, is_required = EXCLUDED.is_required
        `;
      }

      const posted = role.status === "posted";
      await sql`
        INSERT INTO public.requisitions
          (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
           primary_recruiter_id, hiring_manager_id, status, number_of_openings,
           target_start_date, is_public, public_slug, posted_at, updated_at)
        VALUES (${reqId}, ${tid}, ${positionId}, ${jdId}, ${SOLENIS_ENVELOPE},
                ${recruiterId}, ${hiringManagerId}, ${role.status}, ${role.openings},
                (now() + interval '45 days')::date, ${posted}, ${role.slug},
                ${posted ? new Date(Date.now() - 21 * DAY_MS).toISOString() : null}, now())
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status, number_of_openings = EXCLUDED.number_of_openings,
          is_public = EXCLUDED.is_public, public_slug = EXCLUDED.public_slug,
          posted_at = EXCLUDED.posted_at, updated_at = now()
      `;
      await sql`
        INSERT INTO public.requisition_recruiters (tenant_id, requisition_id, recruiter_id)
        VALUES (${tid}, ${reqId}, ${recruiterId})
        ON CONFLICT DO NOTHING
      `;

      // Interview plans — the junior 2-round loop or the senior 3-round loop.
      // Delete-then-insert (mirrors upsertInterviewPlan's replace-set).
      await sql`
        DELETE FROM public.interview_plans WHERE tenant_id = ${tid} AND requisition_id = ${reqId}
      `;
      const rounds = role.seniority === "senior" ? SENIOR_ROUNDS : JUNIOR_ROUNDS;
      for (const r of rounds) {
        await sql`
          INSERT INTO public.interview_plans
            (id, tenant_id, requisition_id, round_number, round_name, duration_minutes,
             mode, scorecard_template, competency_focus, default_panel_membership_ids)
          VALUES (${mkId(KIND.interviewPlan, planN++)}, ${tid}, ${reqId}, ${r.roundNumber},
                  ${r.roundName}, ${r.durationMinutes}, ${r.mode}, ${r.scorecardKey},
                  ${JSON.stringify(r.competencyFocus)}::jsonb,
                  ARRAY[${r.roundNumber === 1 ? hiringManagerId : panelId}]::uuid[])
        `;
      }
    }
    console.log(
      `  ✓ ${ROLES.length} requisitions (positions + approved JDs + ${skillN} JD skills + ${planN} interview rounds)`,
    );

    // ── 6. market benchmarks ───────────────────────────────────────────────
    const removed = await sql`
      DELETE FROM public.market_benchmarks
       WHERE tenant_id = ${tid} AND role_title IN ${sql(GENERIC_BENCHMARK_TITLES)}
      RETURNING role_title
    `;
    for (const bm of BENCHMARKS) {
      await sql`
        INSERT INTO public.market_benchmarks
          (tenant_id, role_title, median_salary_minor, currency, ttf_days, availability,
           competitor_demand, recommended_rounds, trending_skills, source_note, updated_at)
        VALUES (${tid}, ${bm.roleTitle}, ${lpaToPaise(bm.medianLpa)}, 'INR', ${bm.ttfDays},
                ${bm.availability}, ${bm.competitorDemand}, ${bm.recommendedRounds},
                ${JSON.stringify(bm.trendingSkills)}::jsonb, ${BENCHMARK_SOURCE_NOTE}, now())
        ON CONFLICT (tenant_id, role_title) DO UPDATE SET
          median_salary_minor = EXCLUDED.median_salary_minor,
          currency            = EXCLUDED.currency,
          ttf_days            = EXCLUDED.ttf_days,
          availability        = EXCLUDED.availability,
          competitor_demand   = EXCLUDED.competitor_demand,
          recommended_rounds  = EXCLUDED.recommended_rounds,
          trending_skills     = EXCLUDED.trending_skills,
          source_note         = EXCLUDED.source_note,
          updated_at          = now()
      `;
    }
    console.log(
      `  ✓ ${BENCHMARKS.length} Solenis market benchmarks in; ${removed.length} generic tech rows removed`,
    );

    // ── 7. approval routing ────────────────────────────────────────────────
    for (const m of MATRICES) {
      await sql`
        INSERT INTO public.approval_matrices
          (id, tenant_id, subject_type, name, rules, effective_from, effective_to,
           created_by_membership_id, updated_at)
        VALUES (${m.id}, ${tid}, ${m.subjectType}, ${m.name},
                ${JSON.stringify({
                  version: 1,
                  steps: [{ approver_kind: "role", approver_ref: m.approverRef, required: true }],
                  chain_note: m.chainNote,
                })}::jsonb,
                ${MATRIX_EFFECTIVE_FROM}::timestamptz, NULL, ${adminId}, now())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, rules = EXCLUDED.rules,
          effective_from = EXCLUDED.effective_from, effective_to = NULL, updated_at = now()
      `;
    }
    console.log(`  ✓ ${MATRICES.length} approval matrices named for the Solenis chain`);

    // ── 8. interview templates ─────────────────────────────────────────────
    for (const sc of [SCORECARD_PEOPLE, SCORECARD_FUNCTIONAL]) {
      await sql`
        INSERT INTO public.tenant_scorecard_template
          (id, tenant_id, scorecard_key, label, criteria, updated_at)
        VALUES (${sc.id}, ${tid}, ${sc.key}, ${sc.label},
                ${JSON.stringify(sc.criteria)}::jsonb, now())
        ON CONFLICT (tenant_id, scorecard_key) DO UPDATE SET
          label = EXCLUDED.label, criteria = EXCLUDED.criteria, updated_at = now()
      `;
    }
    // Replace-set the tenant default loop: the t22 generic loop (recruiter
    // screen / technical / leadership panel) is cleared so the Solenis loop is
    // the ONLY default. Re-run pnpm db:seed:t22 to restore the generic one.
    await sql`DELETE FROM public.tenant_interview_round_template WHERE tenant_id = ${tid}`;
    for (const r of SENIOR_ROUNDS) {
      await sql`
        INSERT INTO public.tenant_interview_round_template
          (id, tenant_id, round_number, round_name, duration_minutes, mode,
           scorecard_template_key, competency_focus, updated_at)
        VALUES (${mkId(KIND.roundTemplate, r.roundNumber)}, ${tid}, ${r.roundNumber},
                ${r.roundName}, ${r.durationMinutes}, ${r.mode}, ${r.scorecardKey},
                ${JSON.stringify(r.competencyFocus)}::jsonb, now())
        ON CONFLICT (tenant_id, round_number) DO UPDATE SET
          round_name = EXCLUDED.round_name, duration_minutes = EXCLUDED.duration_minutes,
          mode = EXCLUDED.mode, scorecard_template_key = EXCLUDED.scorecard_template_key,
          competency_focus = EXCLUDED.competency_focus, updated_at = now()
      `;
    }
    console.log(
      `  ✓ 2 Solenis scorecards (${SCORECARD_PEOPLE.criteria.length} people + ` +
        `${SCORECARD_FUNCTIONAL.criteria.length} functional criteria) + the 3-round senior loop`,
    );

    // ── 9. sourcing channels ───────────────────────────────────────────────
    for (const s of SOURCE_CHANNELS) {
      await sql`
        INSERT INTO public.tenant_application_sources
          (tenant_id, source_enum, label, enabled, ingestion_mode, config, notes, updated_at)
        VALUES (${tid}, ${s.sourceEnum}::application_source, ${s.label}, ${s.enabled},
                ${s.ingestionMode}, ${JSON.stringify({ seededBy: "solenis" })}::jsonb,
                ${s.notes}, now())
        ON CONFLICT (tenant_id, source_enum) DO UPDATE SET
          label = EXCLUDED.label, enabled = EXCLUDED.enabled,
          ingestion_mode = EXCLUDED.ingestion_mode, config = EXCLUDED.config,
          notes = EXCLUDED.notes, updated_at = now()
      `;
    }
    console.log(`  ✓ ${SOURCE_CHANNELS.length} sourcing channels relabelled to the Solenis mix`);

    // ── 10. partner org Hudson + live MSA ──────────────────────────────────
    await sql`
      INSERT INTO public.partner_orgs
        (id, tenant_id, name, tier, legal_entity_name, country, primary_contact_email,
         active, onboarded_at, updated_at)
      VALUES (${HUDSON_ORG}, ${tid}, ${HUDSON_NAME}, 'empanelled',
              'Hudson RPO India Private Limited', 'IN', ${HUDSON_CONTACT}, true,
              now() - interval '120 days', now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, tier = EXCLUDED.tier,
        legal_entity_name = EXCLUDED.legal_entity_name, country = EXCLUDED.country,
        primary_contact_email = EXCLUDED.primary_contact_email, active = true, updated_at = now()
    `;
    // The LIVE MSA (effective_to IS NULL). Without one the Commercials tab
    // renders empty and partnerSubmitCandidate falls back to its hardcoded
    // 90-day exclusivity. Terms mirror upsertPartnerMsa's write shape.
    await sql`
      INSERT INTO public.partner_msa
        (id, tenant_id, partner_org_id, fee_model, fee_percent, fee_currency,
         exclusivity_window_days, exclusivity_scope, probation_holdback_percent,
         replacement_guarantee_days, effective_from, effective_to,
         created_by_membership_id, updated_at)
      VALUES (${HUDSON_MSA}, ${tid}, ${HUDSON_ORG}, 'percentage_ctc', 8.33, 'INR',
              90, 'org_wide', 25, 90, now() - interval '120 days', NULL, ${adminId}, now())
      ON CONFLICT (id) DO UPDATE SET
        fee_model = EXCLUDED.fee_model, fee_percent = EXCLUDED.fee_percent,
        fee_currency = EXCLUDED.fee_currency,
        exclusivity_window_days = EXCLUDED.exclusivity_window_days,
        exclusivity_scope = EXCLUDED.exclusivity_scope,
        probation_holdback_percent = EXCLUDED.probation_holdback_percent,
        replacement_guarantee_days = EXCLUDED.replacement_guarantee_days,
        effective_to = NULL, updated_at = now()
    `;
    // Assignments on the reqs whose pipeline carries Hudson-sourced candidates,
    // so the partner attribution on those applications is coherent.
    const hudsonReqKeys = ["business-coordinator", "tableau-analyst", "sdl-head-automation"];
    let assignN = 0;
    for (const key of hudsonReqKeys) {
      const role = ROLES.find((r) => r.key === key);
      if (!role) continue;
      await sql`
        INSERT INTO public.partner_assignments
          (id, tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, status)
        VALUES (${mkId(KIND.partnerAssignment, ++assignN)}, ${tid}, ${HUDSON_ORG},
                ${mkId(KIND.requisition, role.index)}, ${recruiterId}, 'active')
        ON CONFLICT (id) DO UPDATE SET status = 'active'
      `;
    }
    console.log(`  ✓ partner org "${HUDSON_NAME}" (empanelled) + live MSA + ${assignN} assignments`);

    // ── 12. onboarding document types ──────────────────────────────────────
    for (const d of DOC_TYPES) {
      await sql`
        INSERT INTO public.document_types
          (id, code, name, geography_code, required_for_lifecycle_stage, retention_years, updated_at)
        VALUES (${mkId(KIND.documentType, d.n)}, ${d.code}, ${d.name}, ${d.geographyCode},
                'pre_boarding', ${d.retentionYears}, now())
        ON CONFLICT (code) DO UPDATE SET
          name = EXCLUDED.name, geography_code = EXCLUDED.geography_code,
          required_for_lifecycle_stage = EXCLUDED.required_for_lifecycle_stage,
          retention_years = EXCLUDED.retention_years, updated_at = now()
      `;
    }
    console.log(
      `  ✓ ${DOC_TYPES.length} onboarding document types added ` +
        "(Aadhaar / PAN / Education Certificate already ship in the migration seed)",
    );

    // ── 11. pipeline ───────────────────────────────────────────────────────
    //
    // Delete-then-reinsert so stage_entered_at re-anchors to THIS run — the
    // ageing / SLA views must show the same healthy-vs-breaching mix every time.
    await deletePipelineRows(sql, tid, { keepIdentities: true });

    const now = Date.now();
    let personN = 0;
    let transitionN = 0;
    const perStage: Record<string, number> = {};

    for (let i = 0; i < APPLICATIONS.length; i++) {
      const a = pick(APPLICATIONS, i);
      const role = ROLES.find((r) => r.key === a.roleKey);
      if (!role) throw new Error(`unknown roleKey ${a.roleKey}`);
      const reqId = mkId(KIND.requisition, role.index);

      const n = personN++;
      const personId = mkId(KIND.person, n);
      const candidateId = mkId(KIND.candidate, n);
      const applicationId = mkId(KIND.application, n);

      const parts = a.fullName.split(" ");
      const first = parts[0] ?? a.fullName;
      const last = parts.slice(1).join(" ") || first;
      // `@example.test`, never `@example.com` — the groom sweeps the .com marker.
      const email = `${first}.${last}`.toLowerCase().replace(/\s+/g, "") + `.gbs${n}@example.test`;
      const phone = "+9198" + String(31000000 + n * 971).slice(0, 8);

      // Walk the happy path up to this candidate's stage; the last hop landed
      // `ageHours` ago, and each earlier hop is spaced by a plausible gap.
      const idx = STAGE_PATH.indexOf(a.stage);
      const stageEnteredAt = new Date(now - a.ageHours * HOUR_MS);
      const GAP_HOURS = [6, 30, 40, 70, 90, 60];
      const hopTimes: Date[] = [stageEnteredAt];
      for (let s = idx - 1; s >= 0; s--) {
        const prev = pick(hopTimes, 0);
        hopTimes.unshift(new Date(prev.getTime() - pick(GAP_HOURS, s) * HOUR_MS));
      }
      const createdAt = pick(hopTimes, 0);

      const scoreBand = STAGE_SCORES[a.stage];
      const score = scoreBand === null ? null : pick(scoreBand, n);

      await sql`
        INSERT INTO public.persons
          (id, tenant_id, full_name, first_name, last_name, email_primary, email_normalised,
           phone_primary, phone_normalised, location_country, location_city, created_at, updated_at)
        VALUES (${personId}, ${tid}, ${a.fullName}, ${first}, ${last}, ${email}, ${email},
                ${phone}, ${phone.replace(/[^0-9]/g, "")}, 'IN', ${HYDERABAD},
                ${ts(createdAt)}, now())
        ON CONFLICT (id) DO UPDATE SET
          full_name = EXCLUDED.full_name, first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name, email_primary = EXCLUDED.email_primary,
          email_normalised = EXCLUDED.email_normalised, phone_primary = EXCLUDED.phone_primary,
          phone_normalised = EXCLUDED.phone_normalised, location_city = EXCLUDED.location_city,
          updated_at = now()
      `;

      // Candidate skills: a prefix of the role's JD skills, longer for stronger
      // candidates, so the skill-gap panel varies per skill instead of reading
      // as a flat wall.
      const take = Math.max(1, Math.min(role.skills.length, 2 + (n % (role.skills.length - 1))));
      const skills = role.skills.slice(0, take);
      await sql`
        INSERT INTO public.candidates
          (id, tenant_id, person_id, source, consent_version, consent_granted_at,
           talent_pool_consent, years_of_experience, parsed_skills, experience_summary,
           created_at, updated_at)
        VALUES (${candidateId}, ${tid}, ${personId}, ${a.source}::application_source, 'v1',
                ${ts(createdAt)}, true, ${a.yearsExperience.toFixed(1)},
                ${JSON.stringify({
                  skills,
                  notice_period_days: pick([30, 45, 60, 90], n),
                  summary: `${a.yearsExperience} years in GBS / shared services — ${skills.slice(0, 3).join(", ")}.`,
                })}::jsonb,
                ${`${a.yearsExperience} yrs — ${skills.slice(0, 3).join(", ")}`},
                ${ts(createdAt)}, now())
        ON CONFLICT (id) DO UPDATE SET
          parsed_skills = EXCLUDED.parsed_skills,
          years_of_experience = EXCLUDED.years_of_experience,
          experience_summary = EXCLUDED.experience_summary, updated_at = now()
      `;

      await sql`
        INSERT INTO public.applications
          (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at,
           assigned_recruiter_membership_id, ai_score, ai_scored_at, knockout_passed,
           knockout_evaluated_at, expected_salary_inr_paise, source_partner_id,
           created_at, updated_at)
        VALUES (${applicationId}, ${tid}, ${candidateId}, ${reqId},
                ${a.source}::application_source, ${a.stage}, ${ts(stageEnteredAt)},
                ${recruiterId}, ${score}, ${score === null ? null : ts(pick(hopTimes, Math.min(1, hopTimes.length - 1)))},
                true, ${ts(createdAt)}, ${lpaToPaise(a.expectedLpa)},
                ${a.source === "partner_empanelled" ? HUDSON_ORG : null},
                ${ts(createdAt)}, now())
      `;
      perStage[a.stage] = (perStage[a.stage] ?? 0) + 1;

      for (let s = 0; s <= idx; s++) {
        await sql`
          INSERT INTO public.application_state_transitions
            (id, tenant_id, application_id, from_stage, to_stage, transitioned_at,
             actor_membership_id, reason)
          VALUES (${mkId(KIND.transition, transitionN++)}, ${tid}, ${applicationId},
                  ${s === 0 ? null : pick(STAGE_PATH, s - 1)}, ${pick(STAGE_PATH, s)},
                  ${ts(pick(hopTimes, s))}, ${recruiterId}, 'Solenis demo seed')
        `;
      }
    }
    console.log(
      `  ✓ ${APPLICATIONS.length} applications + ${transitionN} dated transitions ` +
        `(${Object.entries(perStage).map(([k, v]) => `${k} ${v}`).join(", ")})`,
    );

    console.log("\nSolenis GBS demo mapping seeded.");
    console.log("  Undo with: pnpm db:seed:solenis-demo -- --undo");
  } finally {
    await sql.end({ timeout: 10 });
  }
}

/** Pipeline rows this seed owns, deleted FK-child-first. `keepIdentities`
 * retains persons/candidates (their content is stable) while clearing the rows
 * whose timestamps must re-anchor on a re-run. */
async function deletePipelineRows(
  sql: SqlClient,
  tid: string,
  opts: { keepIdentities: boolean },
): Promise<void> {
  const pfx = `${ID_PREFIX}-%`;
  // Interviews are scoped by APPLICATION, not by id prefix: a round booked
  // through the app carries a random uuid, and leaving it behind would trip
  // uniq_interviews_application_round_active on the next run.
  await sql`
    DELETE FROM public.interviews
     WHERE tenant_id = ${tid} AND application_id::text LIKE ${pfx}
  `;
  await sql`DELETE FROM public.offers WHERE tenant_id = ${tid} AND application_id::text LIKE ${pfx}`;
  await sql`
    DELETE FROM public.application_state_transitions
     WHERE tenant_id = ${tid} AND application_id::text LIKE ${pfx}
  `;
  await sql`DELETE FROM public.applications WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  if (!opts.keepIdentities) {
    await sql`DELETE FROM public.candidates WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
    await sql`DELETE FROM public.persons WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  }
}

async function runUndo(sql: SqlClient, tid: string): Promise<void> {
  console.log(`Removing the Solenis GBS demo mapping from ${TENANT_SLUG} (${tid})\n`);
  const pfx = `${ID_PREFIX}-%`;

  await deletePipelineRows(sql, tid, { keepIdentities: false });

  await sql`DELETE FROM public.partner_assignments WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.partner_msa WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.partner_orgs WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;

  await sql`DELETE FROM public.interview_plans WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.requisition_recruiters WHERE tenant_id = ${tid} AND requisition_id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.requisition_state_transitions WHERE tenant_id = ${tid} AND requisition_id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.requisitions WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.jd_skills WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.jd_versions WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.positions WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.headcount_envelopes WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.business_units WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.comp_bands WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;

  await sql`DELETE FROM public.approval_matrices WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.tenant_interview_round_template WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;
  await sql`DELETE FROM public.tenant_scorecard_template WHERE tenant_id = ${tid} AND id::text LIKE ${pfx}`;

  await sql`
    DELETE FROM public.market_benchmarks
     WHERE tenant_id = ${tid} AND role_title IN ${sql(ROLE_TITLES)}
  `;
  await sql`DELETE FROM public.document_types WHERE code IN ${sql(DOC_TYPE_CODES)}`;

  console.log(`  ✓ removed every ${ID_PREFIX}-* row + the ${ROLE_TITLES.length} Solenis benchmarks`);
  console.log(
    "  ! NOT reverted (edits to PRE-EXISTING rows, by design):\n" +
      "      - tenants.display_name / settings.branding / settings.slaThresholds\n" +
      "      - the relabelled tenant_application_sources rows\n" +
      "      - the generic tech market_benchmarks rows this seed deleted\n" +
      "        (restore with: pnpm db:seed:benchmarks)\n" +
      "      - the generic tenant interview round-template loop\n" +
      "        (restore with: pnpm db:seed:t22)",
  );
}

main().catch((err) => {
  console.error("seed-solenis-demo failed:", err);
  process.exit(1);
});
