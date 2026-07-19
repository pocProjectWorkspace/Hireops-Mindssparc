/**
 * RO-02 — curated role templates for the wizard v2 "Quick start" chip row.
 *
 * These are CURATED PRESETS, not data — a small hand-authored set that
 * prefills the Basics + Skills steps so a requirement owner starts from a
 * sensible baseline instead of a blank form. They live in code (no DB, no AI),
 * are clearly labelled "curated" in the UI, and every field stays fully
 * editable afterwards. Budgets are annual INR ranges (the platform is
 * INR-first); adjust to the real band before submitting.
 *
 * Skill presets carry the RO-02 additive fields (category / weight /
 * isRequired / minYears) so applying a template lands a ready-to-tune weighting
 * table, but nothing here is authoritative — it is a starting point.
 */

import type { RequisitionLocationType, RequisitionSkillInput } from "@hireops/api-types";

export interface RoleTemplateSkill extends RequisitionSkillInput {
  category: string;
}

export interface RoleTemplate {
  id: string;
  /** Short chip label. */
  label: string;
  title: string;
  seniority: string;
  locationType: RequisitionLocationType;
  /** Annual INR budget band (min/max), shown as a hint; fully editable. */
  budgetMinInr: number;
  budgetMaxInr: number;
  /** Optional steer text prefilled into the JD generator's extra-context box. */
  extraContext: string;
  skills: RoleTemplateSkill[];
}

const s = (
  skillName: string,
  category: string,
  weight: number,
  isRequired: boolean,
  minYears?: number,
): RoleTemplateSkill => ({ skillName, category, weight, isRequired, minYears: minYears ?? null });

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "senior-backend",
    label: "Senior Backend Engineer",
    title: "Senior Backend Engineer",
    seniority: "Senior",
    locationType: "hybrid",
    budgetMinInr: 2800000,
    budgetMaxInr: 4200000,
    extraContext:
      "Backend platform team; strong distributed-systems and event-streaming depth expected.",
    skills: [
      s("Java", "Languages", 9, true, 5),
      s("Spring Boot", "Frameworks", 8, true, 4),
      s("Kafka", "Infrastructure", 7, true, 3),
      s("PostgreSQL", "Databases", 6, true, 3),
      s("Kubernetes", "Infrastructure", 5, false, 2),
    ],
  },
  {
    id: "frontend-engineer",
    label: "Frontend Engineer",
    title: "Frontend Engineer",
    seniority: "Mid",
    locationType: "hybrid",
    budgetMinInr: 1800000,
    budgetMaxInr: 3000000,
    extraContext: "Product-facing React team; accessibility and design-system fluency valued.",
    skills: [
      s("React", "Frameworks", 9, true, 3),
      s("TypeScript", "Languages", 8, true, 3),
      s("CSS / Tailwind", "Styling", 6, true, 2),
      s("Accessibility (WCAG)", "Craft", 5, false),
      s("Testing (Playwright/Jest)", "Quality", 5, false, 2),
    ],
  },
  {
    id: "data-engineer",
    label: "Data Engineer",
    title: "Data Engineer",
    seniority: "Senior",
    locationType: "remote",
    budgetMinInr: 2600000,
    budgetMaxInr: 4000000,
    extraContext: "Analytics platform; batch + streaming pipelines, strong SQL and modelling.",
    skills: [
      s("Python", "Languages", 8, true, 4),
      s("SQL", "Databases", 9, true, 4),
      s("Spark", "Infrastructure", 7, true, 3),
      s("Airflow", "Infrastructure", 6, false, 2),
      s("dbt", "Tooling", 5, false),
    ],
  },
  {
    id: "product-manager",
    label: "Product Manager",
    title: "Product Manager",
    seniority: "Senior",
    locationType: "onsite",
    budgetMinInr: 3000000,
    budgetMaxInr: 4800000,
    extraContext: "B2B SaaS product; discovery-led, comfortable with data and enterprise buyers.",
    skills: [
      s("Product discovery", "Craft", 9, true, 4),
      s("Roadmapping", "Craft", 7, true, 3),
      s("Data analysis / SQL", "Analytics", 6, true, 2),
      s("Stakeholder management", "Leadership", 7, true, 3),
      s("Enterprise SaaS domain", "Domain", 5, false, 2),
    ],
  },
  {
    id: "devops-sre",
    label: "DevOps / SRE",
    title: "Site Reliability Engineer",
    seniority: "Senior",
    locationType: "hybrid",
    budgetMinInr: 2800000,
    budgetMaxInr: 4400000,
    extraContext: "Reliability-focused; IaC, observability, and incident response ownership.",
    skills: [
      s("Kubernetes", "Infrastructure", 9, true, 4),
      s("Terraform", "Infrastructure", 8, true, 3),
      s("AWS / GCP", "Cloud", 8, true, 4),
      s("Observability (Prometheus/Grafana)", "Tooling", 6, false, 2),
      s("Incident response", "Craft", 6, false, 3),
    ],
  },
  {
    id: "qa-automation",
    label: "QA Automation Engineer",
    title: "QA Automation Engineer",
    seniority: "Mid",
    locationType: "remote",
    budgetMinInr: 1600000,
    budgetMaxInr: 2800000,
    extraContext: "Quality engineering; automation-first, CI-integrated test suites.",
    skills: [
      s("Test automation", "Quality", 9, true, 3),
      s("Playwright / Selenium", "Tooling", 8, true, 3),
      s("TypeScript / Python", "Languages", 6, true, 2),
      s("CI/CD pipelines", "Infrastructure", 6, false, 2),
      s("API testing", "Quality", 5, false, 2),
    ],
  },
];
