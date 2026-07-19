/**
 * HROPS-03 Templates & policies seed — the curated HR reference library for the
 * demo tenant (kyndryl-poc). These are the read-only cards /hr-policies renders:
 * offer templates, benefits, and people policies, written as INDIA-appropriate,
 * labour-law-neutral CURATED REFERENCE content (the UI labels them as such).
 * NOT legal advice, NOT AI-generated, no UAE artefacts.
 *
 * Run:
 *   pnpm db:seed:hr-policies
 *
 * Requires: DATABASE_URL in .env, the kyndryl-poc tenant, and migration 0065+
 * (hr_policy_documents).
 *
 * SEVEN-seed runbook order (each idempotent; run in this order on a fresh DB):
 *   1. db:seed:test-users      (auth users + memberships)
 *   2. db:seed:demo-data       (recruitment + onboarding a5xx fixtures)
 *   3. db:seed:partner-demo    (partner org + login, a6xx)
 *   4. db:seed:candidate-demo  (Priya's candidate login, a7xx)
 *   5. db:seed:offboard-demo   (the two departure cases, a8xx)
 *   6. db:seed:benchmarks      (market benchmarks)
 *   7. db:seed:hr-policies     (this seed)
 *
 * Idempotent: upsert keyed on (tenant_id, title) — a second run refreshes the
 * body + timestamps, never duplicates. Order-independent w.r.t. the other seeds
 * (depends only on the tenant existing).
 *
 * Groom-safe by construction: hr_policy_documents is in NO groom residue class
 * (groom-demo-data.ts never sweeps it), and the table carries no audit trigger
 * (deliberate — see migration 0067) so re-runs don't spray audit noise.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

type Category = "offers" | "benefits" | "policies";

interface PolicySeed {
  title: string;
  category: Category;
  summary: string;
  bodyMd: string;
}

const POLICIES: PolicySeed[] = [
  {
    title: "Standard Offer Letter Template",
    category: "offers",
    summary:
      "The reference structure for a full-time employment offer: compensation breakdown, joining formalities, and the documents we request before Day 1.",
    bodyMd: `## Purpose
Curated reference template for drafting full-time employment offers. Adapt per role and grade; final wording is owned by HR operations.

## Structure
- **Position & reporting** — role title, business unit, work location, and reporting manager.
- **Compensation** — annual fixed pay (broken into basic, HRA, and special allowance), variable pay target, and any joining bonus, each stated in INR per annum.
- **Statutory components** — employer Provident Fund contribution and gratuity eligibility as per the applicable rules; these are listed separately from fixed pay.
- **Joining date & validity** — the proposed date of joining and the date the offer lapses if unaccepted.
- **Pre-joining requirements** — identity and eligibility documents (PAN, Aadhaar where consented, education certificates, prior-employment relieving letters) and background verification consent.

## Notes for drafters
- State amounts in both figures and words for the total fixed pay.
- Probation terms, notice period, and confidentiality obligations reference the employment agreement, not the offer letter.
- Never include demographic questions of any kind in the offer flow.`,
  },
  {
    title: "Group Health Insurance Policy",
    category: "benefits",
    summary:
      "Reference summary of employee medical cover: floater sum insured, dependant coverage, and how to raise a claim.",
    bodyMd: `## Coverage
- **Group mediclaim** — a family-floater sum insured per employee per policy year, covering the employee, spouse, and up to two children; parental cover available as a paid top-up at enrolment.
- **Hospitalisation** — in-patient treatment, day-care procedures, pre- and post-hospitalisation expenses within policy limits, and cashless treatment at network hospitals.
- **Maternity** — covered within the sub-limit stated in the policy schedule, including newborn cover from day one after intimation.

## Enrolment
- New joiners are enrolled from their date of joining; dependant details are captured during onboarding.
- Changes to dependants are accepted within 30 days of a life event (marriage, birth) — otherwise at annual renewal.

## Claims
- **Cashless** — present the health card at a network hospital; intimate the insurer's helpdesk within 24 hours of admission.
- **Reimbursement** — submit bills within 30 days of discharge via the HR helpdesk.

## Reference
This is a curated summary. The insurer's policy schedule is the binding document; contact HR operations for the current schedule.`,
  },
  {
    title: "Leave Policy",
    category: "policies",
    summary:
      "Reference leave entitlements: earned, casual, and sick leave, national and festival holidays, and the application process.",
    bodyMd: `## Entitlements (per calendar year)
- **Earned leave** — accrued monthly; carry-forward up to the cap stated in the employee handbook, with encashment per the applicable rules.
- **Casual leave** — for personal exigencies; lapses at year end.
- **Sick leave** — medical certificate required beyond two consecutive days.
- **Public holidays** — national holidays plus a regional festival-holiday list published each January.

## Special leave
- **Maternity leave** — as per the applicable maternity-benefit rules communicated by HR.
- **Paternity leave** — as stated in the employee handbook.
- **Bereavement leave** — up to five working days for an immediate family member.

## Process
- Apply in the HR system with your manager's approval; for planned leave of five or more days, apply at least two weeks ahead.
- Unapproved absence beyond three days triggers an HR follow-up.

Curated reference content — the employee handbook is the governing document.`,
  },
  {
    title: "Probation & Confirmation Guidelines",
    category: "policies",
    summary:
      "Reference guidance on the probation window, mid-probation check-ins, confirmation criteria, and extension handling.",
    bodyMd: `## Probation window
- Standard probation is **90 days** from the date of joining (aligned to the onboarding case's probation tracker), extendable once where performance needs more runway.

## During probation
- A structured 30/60/90-day check-in cadence between the employee, their manager, and their onboarding buddy.
- Goals set in the first two weeks; feedback recorded at each check-in.

## Confirmation
- The manager recommends confirmation before the probation end date; HR operations issues the confirmation letter.
- If probation is extended, the extension letter states the revised end date and the specific expectations.

## Exit during probation
- Either side may separate with the shorter notice period stated in the employment agreement for probationary employees.

Curated reference content — apply with manager and HR-operations judgement per case.`,
  },
  {
    title: "Relocation Allowance Policy",
    category: "benefits",
    summary:
      "Reference support for candidates and employees relocating for a role: eligible expenses, limits, and the claim process.",
    bodyMd: `## Eligibility
- New joiners relocating more than 100 km to their work location, and existing employees on company-initiated transfers.

## What's covered
- **Travel** — one-way travel for the employee and immediate family.
- **Movement of household goods** — packers-and-movers charges against invoices, within the grade-wise cap.
- **Temporary accommodation** — up to 15 days of company-arranged or reimbursed stay near the work location.
- **Joining travel advance** — available on request, adjusted against the first payroll.

## Process
- Claims within 60 days of joining/transfer via the HR helpdesk with original invoices.
- Amounts above the grade cap need business-unit head approval.

## Clawback
- If the employee resigns within 12 months of joining, the relocation amount is recoverable per the employment agreement.

Curated reference content — grade-wise caps live in the current compensation annexure.`,
  },
  {
    title: "Employee Referral Program",
    category: "policies",
    summary:
      "Reference rules for the internal referral program: who can refer, referral bonus timing, and how referrals flow into the pipeline.",
    bodyMd: `## How it works
- Any employee (except HR operations staff working the requisition and the hiring manager for the role) can refer a candidate against an open, posted requisition.
- Referrals enter the SAME pipeline as every other source, flagged with the referral source — screening and interviews are identical; referring someone never bypasses a stage.

## Referral bonus
- Payable when the referred candidate **completes 90 days** of employment (the probation window), via payroll.
- Bonus amounts are grade-banded and published in the current referral-bonus annexure.
- Where two employees refer the same candidate, the first submission in the system wins (mirrors the partner first-valid-submission rule).

## Good practice
- Refer people whose work you can genuinely speak to; add a short note on how you know them.
- No referral fees for candidates already active in the pipeline in the last 6 months.

Curated reference content — the annexure and payroll calendar govern amounts and timing.`,
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
    console.log(`Seeding ${POLICIES.length} HR policy documents into ${TENANT_SLUG} (${tid})`);

    for (const p of POLICIES) {
      await poolSql`
        INSERT INTO public.hr_policy_documents
          (tenant_id, title, category, summary, body_md, updated_at)
        VALUES
          (${tid}, ${p.title}, ${p.category}, ${p.summary}, ${p.bodyMd}, now())
        ON CONFLICT (tenant_id, title) DO UPDATE SET
          category   = EXCLUDED.category,
          summary    = EXCLUDED.summary,
          body_md    = EXCLUDED.body_md,
          updated_at = now()
      `;
      console.log(`  ✓ [${p.category}] ${p.title}`);
    }

    console.log("HR policy documents seeded.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-hr-policies failed:", err);
  process.exit(1);
});
