/**
 * T1.3 (G13) approval-routing seed — configurable, effective-dated approval
 * matrices for the demo tenant. OPTION (b): SINGLE-STEP matrices only. We
 * demonstrate configurability by changing WHO approves + effective-dating a
 * change, NOT by adding steps (a second step would be silently ignored by the
 * decision spine — the exact config-lie this ticket exists to kill).
 *
 * For each of requisition + out-of-band offer:
 *   - an ACTIVE single-step hr_head policy (effective 2026-01-01, no end) — this
 *     keeps req-03 / hrops-02 resolving a single hr_head step today;
 *   - a SCHEDULED single-step admin policy (effective 2026-09-01) — a future-
 *     dated approver change that is NOT in force now, demoing effective-dated
 *     routing without touching today's chains.
 *
 * Fixed-UUID + delete-by-id-then-insert → fully idempotent (a re-seed resets).
 * Distinct t13 id namespace (…000013xx). No new migration — approval_matrices
 * already exists.
 *
 * Runbook: `pnpm db:seed:t13` (root passthrough). Requires the demo tenant
 * (db:migrate first). NOT run as part of the test gates.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

// t13 namespace (…000013xx — free).
const REQ_ACTIVE = "00000000-0000-4000-8000-000000001301";
const REQ_SCHEDULED = "00000000-0000-4000-8000-000000001302";
const OFFER_ACTIVE = "00000000-0000-4000-8000-000000001303";
const OFFER_SCHEDULED = "00000000-0000-4000-8000-000000001304";

const ALL_IDS = [REQ_ACTIVE, REQ_SCHEDULED, OFFER_ACTIVE, OFFER_SCHEDULED];

function singleStepRules(approverRef: string) {
  return {
    version: 1,
    steps: [{ approver_kind: "role", approver_ref: approverRef, required: true }],
  };
}

interface SeedMatrix {
  id: string;
  subjectType: "requisition" | "offer";
  name: string;
  approverRef: string;
  effectiveFrom: string; // ISO date
  effectiveTo: string | null;
}

const MATRICES: SeedMatrix[] = [
  {
    id: REQ_ACTIVE,
    subjectType: "requisition",
    name: "Requisition approval — HR Head",
    approverRef: "hr_head",
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
  },
  {
    id: REQ_SCHEDULED,
    subjectType: "requisition",
    name: "Requisition approval — Admin (scheduled)",
    approverRef: "admin",
    effectiveFrom: "2026-09-01T00:00:00Z",
    effectiveTo: null,
  },
  {
    id: OFFER_ACTIVE,
    subjectType: "offer",
    name: "Out-of-band offer approval — HR Head",
    approverRef: "hr_head",
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
  },
  {
    id: OFFER_SCHEDULED,
    subjectType: "offer",
    name: "Out-of-band offer approval — Admin (scheduled)",
    approverRef: "admin",
    effectiveFrom: "2026-09-01T00:00:00Z",
    effectiveTo: null,
  },
];

async function main() {
  const { db, sql: poolSql } = await import("../client");
  const { tenants } = await import("../schema");
  const { eq } = await import("drizzle-orm");

  try {
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

    // Delete-by-id (idempotent reset). Any chains referencing these matrices are
    // left intact — matrix_id is nullable/SET NULL, and chains are immutable
    // history; a re-seed only rewrites the policy rows themselves.
    for (const id of ALL_IDS) {
      await poolSql`DELETE FROM public.approval_matrices WHERE id = ${id}`;
    }

    for (const m of MATRICES) {
      await poolSql`
        INSERT INTO public.approval_matrices
          (id, tenant_id, subject_type, name, rules, effective_from, effective_to)
        VALUES (
          ${m.id}, ${tid}, ${m.subjectType}, ${m.name},
          ${JSON.stringify(singleStepRules(m.approverRef))}::jsonb,
          ${m.effectiveFrom}::timestamptz,
          ${m.effectiveTo}::timestamptz
        )
      `;
    }

    console.log("T1.3 approval-routing matrices seeded (single-step, effective-dated).");
    console.log("  requisition: ACTIVE hr_head (2026-01-01) + SCHEDULED admin (2026-09-01)");
    console.log("  offer:       ACTIVE hr_head (2026-01-01) + SCHEDULED admin (2026-09-01)");
    console.log("  Admin surface: /admin/approval-routing");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
