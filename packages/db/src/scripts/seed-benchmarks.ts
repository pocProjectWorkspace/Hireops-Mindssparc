/**
 * HRHEAD-02 Market Intelligence seed — curated, HONEST market benchmarks for
 * the demo tenant (kyndryl-poc). These are the reference rows the HR-head
 * "Market Intelligence" table + trending-skills cards render, and the rows the
 * Feasibility page fuzzy-matches a requisition against. They are NOT a live
 * feed — every row carries a `source_note` that says so.
 *
 * Coverage: the seeded requisition titles from seed-demo-data.ts (Senior
 * Backend Engineer, Data Platform Engineer, Product Designer, Staff Frontend
 * Engineer + the demo positions: Engineering Manager Platform, Senior Data
 * Scientist, Principal SRE) plus a few adjacent roles, so the feasibility
 * fuzzy-matcher lands a benchmark for every demo req and the honest
 * "no benchmark" fallback is still reachable for an off-list title.
 *
 * MONEY: `median_salary_minor` is INR paise (minor units) — matching
 * offers.base_salary_inr_paise, NOT the positions.comp_band_* major-rupee
 * convention. 1 LPA = 100,000 rupees = 10,000,000 paise. Medians are set to sit
 * inside/near the seeded comp bands so the "median vs budget" story is credible.
 *
 * Run:
 *   pnpm db:seed:benchmarks
 *
 * Requires: DATABASE_URL in .env, and the kyndryl-poc tenant (db:migrate).
 *
 * SIX-seed runbook order (each idempotent; run in this order on a fresh DB):
 *   1. db:seed:test-users      (auth users + memberships)
 *   2. db:seed:demo-data       (recruitment + onboarding a5xx fixtures)
 *   3. db:seed:partner-demo    (partner org + login, a6xx)
 *   4. db:seed:candidate-demo  (Priya's candidate login, a7xx)
 *   5. db:seed:offboard-demo   (the two departure cases, a8xx)
 *   6. db:seed:benchmarks      (market benchmarks)                 ← this seed
 *
 * Idempotent: upsert keyed on (tenant_id, role_title) — a second run refreshes
 * numbers + timestamps, never duplicates. Order-independent w.r.t. the other
 * seeds (depends only on the tenant existing).
 *
 * Groom-safe by construction: market_benchmarks is in NO groom residue class
 * (groom-demo-data.ts sweeps agents / onboarding / interviews / candidate
 * accounts / requisition residue / marker-email persons — never this table).
 * Verify with `pnpm db:groom:demo-data` (dry run): zero new classification.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";
const SOURCE_NOTE = "Curated benchmark — update quarterly";

/** 1 LPA (lakh per annum) → INR paise (minor units), as a string for the
 * bigint column (the postgres tagged-template client won't bind a raw bigint). */
const lpaToPaise = (lpa: number): string => Math.round(lpa * 10_000_000).toString();

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

const BENCHMARKS: BenchmarkSeed[] = [
  {
    roleTitle: "Senior Backend Engineer",
    medianLpa: 42,
    ttfDays: 45,
    availability: "medium",
    competitorDemand: "high",
    recommendedRounds: 4,
    trendingSkills: ["Go", "Kubernetes", "Distributed Systems", "Event-driven architecture"],
  },
  {
    roleTitle: "Staff Frontend Engineer",
    medianLpa: 48,
    ttfDays: 52,
    availability: "low",
    competitorDemand: "high",
    recommendedRounds: 4,
    trendingSkills: ["React", "TypeScript", "Design Systems", "Web performance"],
  },
  {
    roleTitle: "Senior Frontend Engineer",
    medianLpa: 38,
    ttfDays: 42,
    availability: "medium",
    competitorDemand: "high",
    recommendedRounds: 3,
    trendingSkills: ["React", "TypeScript", "Accessibility", "Testing"],
  },
  {
    roleTitle: "Data Platform Engineer",
    medianLpa: 45,
    ttfDays: 50,
    availability: "low",
    competitorDemand: "high",
    recommendedRounds: 4,
    trendingSkills: ["Spark", "dbt", "Airflow", "Snowflake"],
  },
  {
    roleTitle: "Product Designer",
    medianLpa: 34,
    ttfDays: 40,
    availability: "medium",
    competitorDemand: "medium",
    recommendedRounds: 3,
    trendingSkills: ["Figma", "Design Systems", "User Research", "Prototyping"],
  },
  {
    roleTitle: "Engineering Manager, Platform",
    medianLpa: 78,
    ttfDays: 62,
    availability: "low",
    competitorDemand: "medium",
    recommendedRounds: 5,
    trendingSkills: ["People Leadership", "System Design", "Hiring", "Delivery"],
  },
  {
    roleTitle: "Senior Data Scientist",
    medianLpa: 50,
    ttfDays: 55,
    availability: "medium",
    competitorDemand: "high",
    recommendedRounds: 4,
    trendingSkills: ["Python", "Machine Learning", "LLMs", "Experimentation"],
  },
  {
    roleTitle: "Principal Site Reliability Engineer",
    medianLpa: 66,
    ttfDays: 65,
    availability: "low",
    competitorDemand: "high",
    recommendedRounds: 4,
    trendingSkills: ["SLOs", "Terraform", "Observability", "Incident Response"],
  },
  {
    roleTitle: "Backend Engineer",
    medianLpa: 28,
    ttfDays: 35,
    availability: "high",
    competitorDemand: "medium",
    recommendedRounds: 3,
    trendingSkills: ["Java", "Spring", "REST APIs", "SQL"],
  },
  {
    roleTitle: "DevOps Engineer",
    medianLpa: 32,
    ttfDays: 38,
    availability: "medium",
    competitorDemand: "high",
    recommendedRounds: 3,
    trendingSkills: ["CI/CD", "Docker", "AWS", "Kubernetes"],
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
    console.log(`Seeding ${BENCHMARKS.length} market benchmarks into ${TENANT_SLUG} (${tid})`);

    for (const b of BENCHMARKS) {
      await poolSql`
        INSERT INTO public.market_benchmarks
          (tenant_id, role_title, median_salary_minor, currency, ttf_days,
           availability, competitor_demand, recommended_rounds, trending_skills,
           source_note, updated_at)
        VALUES
          (${tid}, ${b.roleTitle}, ${lpaToPaise(b.medianLpa)}, 'INR', ${b.ttfDays},
           ${b.availability}, ${b.competitorDemand}, ${b.recommendedRounds},
           ${JSON.stringify(b.trendingSkills)}::jsonb, ${SOURCE_NOTE}, now())
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
      console.log(`  ✓ ${b.roleTitle} — ₹${b.medianLpa} LPA median`);
    }

    console.log("Market benchmarks seeded.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-benchmarks failed:", err);
  process.exit(1);
});
