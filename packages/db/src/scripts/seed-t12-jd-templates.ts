/**
 * T12 / G11 — JD-template library seed.
 *
 * Seeds the six ROLE_TEMPLATES presets (the wizard's "Quick start" row) into the
 * jd_templates table for the demo tenant (kyndryl-poc). Once seeded, the
 * requisition wizard reads its Quick-start chips from the DB and falls back to
 * the in-code ROLE_TEMPLATES constant only when the table is empty. admin +
 * hiring_manager curate the library on /jd-library → Templates.
 *
 * These mirror apps/internal-portal/src/components/requisitions/
 * requisition-templates.ts (kept as the offline fallback). The values are
 * CURATED PRESETS, not authoritative data — everything stays editable after
 * applying, and the legal-clause text is India-neutral starting material that
 * has NOT been legally reviewed.
 *
 * MONEY: budget_min_inr / budget_max_inr are annual INR in MAJOR units (rupees),
 * matching positions.comp_band_* and the wizard's compBand fields — NOT the
 * paise convention.
 *
 * Run:
 *   pnpm db:seed:t12-jd-templates
 *
 * Requires: DATABASE_URL in .env, and the kyndryl-poc tenant (db:migrate).
 *
 * Idempotent: fixed UUIDs, delete-by-id then insert — a re-run refreshes the six
 * rows in place and never duplicates. Order-independent w.r.t. the other seeds
 * (depends only on the tenant existing).
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

const LEGAL_CLAUSES = [
  "We are an equal-opportunity employer. We do not discriminate on the basis of caste, religion, gender, gender identity, sexual orientation, disability, age, marital status, or any other protected characteristic.",
  "Reasonable accommodations are available on request throughout the hiring process.",
  "Curated starting text — not legally reviewed. Adapt to your entity and local labour law before publishing.",
].join("\n");

interface SeedSkill {
  skillName: string;
  category: string;
  weight: number;
  isRequired: boolean;
  minYears: number | null;
}

interface SeedTemplate {
  id: string;
  label: string;
  title: string;
  roleFamily: string;
  seniority: string;
  locationType: "remote" | "hybrid" | "onsite" | "multi";
  budgetMinInr: number;
  budgetMaxInr: number;
  extraContext: string;
  bodyMd: string;
  sortOrder: number;
  skills: SeedSkill[];
}

const s = (
  skillName: string,
  category: string,
  weight: number,
  isRequired: boolean,
  minYears?: number,
): SeedSkill => ({ skillName, category, weight, isRequired, minYears: minYears ?? null });

const TEMPLATES: SeedTemplate[] = [
  {
    id: "00000000-0000-4000-8000-000000a12001",
    label: "Senior Backend Engineer",
    title: "Senior Backend Engineer",
    roleFamily: "Engineering",
    seniority: "Senior",
    locationType: "hybrid",
    budgetMinInr: 2800000,
    budgetMaxInr: 4200000,
    extraContext:
      "Backend platform team; strong distributed-systems and event-streaming depth expected.",
    bodyMd:
      "## About the role\nOwn backend services on our platform team — design, build, and operate distributed systems that stay reliable at scale.\n\n## What you'll do\n- Design and ship backend services and APIs\n- Own reliability, observability, and performance of your services\n- Collaborate closely with product and platform peers",
    sortOrder: 10,
    skills: [
      s("Java", "Languages", 9, true, 5),
      s("Spring Boot", "Frameworks", 8, true, 4),
      s("Kafka", "Infrastructure", 7, true, 3),
      s("PostgreSQL", "Databases", 6, true, 3),
      s("Kubernetes", "Infrastructure", 5, false, 2),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000a12002",
    label: "Frontend Engineer",
    title: "Frontend Engineer",
    roleFamily: "Engineering",
    seniority: "Mid",
    locationType: "hybrid",
    budgetMinInr: 1800000,
    budgetMaxInr: 3000000,
    extraContext: "Product-facing React team; accessibility and design-system fluency valued.",
    bodyMd:
      "## About the role\nBuild product-facing interfaces on our React web app with a strong eye for accessibility and craft.\n\n## What you'll do\n- Build accessible, performant UI in React + TypeScript\n- Contribute to our design system\n- Partner with design and backend on end-to-end features",
    sortOrder: 20,
    skills: [
      s("React", "Frameworks", 9, true, 3),
      s("TypeScript", "Languages", 8, true, 3),
      s("CSS / Tailwind", "Styling", 6, true, 2),
      s("Accessibility (WCAG)", "Craft", 5, false),
      s("Testing (Playwright/Jest)", "Quality", 5, false, 2),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000a12003",
    label: "Data Engineer",
    title: "Data Engineer",
    roleFamily: "Data",
    seniority: "Senior",
    locationType: "remote",
    budgetMinInr: 2600000,
    budgetMaxInr: 4000000,
    extraContext: "Analytics platform; batch + streaming pipelines, strong SQL and modelling.",
    bodyMd:
      "## About the role\nBuild and operate the batch and streaming pipelines behind our analytics platform.\n\n## What you'll do\n- Design robust, well-modelled data pipelines\n- Own data quality and lineage\n- Enable analysts and product teams with reliable datasets",
    sortOrder: 30,
    skills: [
      s("Python", "Languages", 8, true, 4),
      s("SQL", "Databases", 9, true, 4),
      s("Spark", "Infrastructure", 7, true, 3),
      s("Airflow", "Infrastructure", 6, false, 2),
      s("dbt", "Tooling", 5, false),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000a12004",
    label: "Product Manager",
    title: "Product Manager",
    roleFamily: "Product",
    seniority: "Senior",
    locationType: "onsite",
    budgetMinInr: 3000000,
    budgetMaxInr: 4800000,
    extraContext: "B2B SaaS product; discovery-led, comfortable with data and enterprise buyers.",
    bodyMd:
      "## About the role\nOwn a slice of our B2B SaaS product end-to-end — from discovery to delivery — for enterprise customers.\n\n## What you'll do\n- Run discovery and shape the roadmap\n- Partner with engineering and design on delivery\n- Work directly with enterprise buyers and stakeholders",
    sortOrder: 40,
    skills: [
      s("Product discovery", "Craft", 9, true, 4),
      s("Roadmapping", "Craft", 7, true, 3),
      s("Data analysis / SQL", "Analytics", 6, true, 2),
      s("Stakeholder management", "Leadership", 7, true, 3),
      s("Enterprise SaaS domain", "Domain", 5, false, 2),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000a12005",
    label: "DevOps / SRE",
    title: "Site Reliability Engineer",
    roleFamily: "Engineering",
    seniority: "Senior",
    locationType: "hybrid",
    budgetMinInr: 2800000,
    budgetMaxInr: 4400000,
    extraContext: "Reliability-focused; IaC, observability, and incident response ownership.",
    bodyMd:
      "## About the role\nOwn the reliability of our platform — infrastructure-as-code, observability, and incident response.\n\n## What you'll do\n- Build and maintain infrastructure with Terraform + Kubernetes\n- Own SLOs, observability, and on-call practices\n- Lead incident response and post-incident learning",
    sortOrder: 50,
    skills: [
      s("Kubernetes", "Infrastructure", 9, true, 4),
      s("Terraform", "Infrastructure", 8, true, 3),
      s("AWS / GCP", "Cloud", 8, true, 4),
      s("Observability (Prometheus/Grafana)", "Tooling", 6, false, 2),
      s("Incident response", "Craft", 6, false, 3),
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000a12006",
    label: "QA Automation Engineer",
    title: "QA Automation Engineer",
    roleFamily: "Quality Engineering",
    seniority: "Mid",
    locationType: "remote",
    budgetMinInr: 1600000,
    budgetMaxInr: 2800000,
    extraContext: "Quality engineering; automation-first, CI-integrated test suites.",
    bodyMd:
      "## About the role\nDrive quality through automation-first, CI-integrated test suites across our products.\n\n## What you'll do\n- Build and maintain automated test suites\n- Integrate testing into CI/CD pipelines\n- Partner with engineering to raise the quality bar",
    sortOrder: 60,
    skills: [
      s("Test automation", "Quality", 9, true, 3),
      s("Playwright / Selenium", "Tooling", 8, true, 3),
      s("TypeScript / Python", "Languages", 6, true, 2),
      s("CI/CD pipelines", "Infrastructure", 6, false, 2),
      s("API testing", "Quality", 5, false, 2),
    ],
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
    console.log(`Seeding ${TEMPLATES.length} JD templates into ${TENANT_SLUG} (${tid})`);

    for (const t of TEMPLATES) {
      // Idempotent: delete-by-id then insert (fixed UUIDs).
      await poolSql`DELETE FROM public.jd_templates WHERE id = ${t.id} AND tenant_id = ${tid}`;
      await poolSql`
        INSERT INTO public.jd_templates
          (id, tenant_id, label, title, role_family, seniority, location_type,
           budget_min_inr, budget_max_inr, extra_context, body_md, legal_clauses,
           skills, is_archived, sort_order, created_at, updated_at)
        VALUES
          (${t.id}, ${tid}, ${t.label}, ${t.title}, ${t.roleFamily}, ${t.seniority},
           ${t.locationType}, ${t.budgetMinInr}, ${t.budgetMaxInr}, ${t.extraContext},
           ${t.bodyMd}, ${LEGAL_CLAUSES}, ${JSON.stringify(t.skills)}::jsonb, false,
           ${t.sortOrder}, now(), now())
      `;
      console.log(`  ✓ ${t.label} — ${t.roleFamily} / ${t.seniority}`);
    }

    console.log("JD templates seeded.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-t12-jd-templates failed:", err);
  process.exit(1);
});
