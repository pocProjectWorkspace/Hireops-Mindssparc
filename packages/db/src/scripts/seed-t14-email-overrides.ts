/**
 * T1.4 / G09 email-copy-override seed — a couple of branded overrides for the
 * demo tenant (kyndryl-poc) so /admin/email-templates lands with a live example
 * of a customised subject + sign-off. These are tenant CONFIG rows over the
 * code-owned templates: only the subject + named slots are overridden; layout,
 * styles, and data bindings are untouched.
 *
 * NAMESPACE: every seeded row uses a fixed t14 UUID (identifiable + idempotent).
 * The block DELETEs by id (and by the (tenant, template_key) unique key, to
 * avoid a conflict if a hand-edit created the same override) then INSERTs — a
 * second run refreshes, never duplicates.
 *
 * Run:
 *   pnpm db:seed:t14
 *
 * Requires: DATABASE_URL in .env, and the kyndryl-poc tenant (db:migrate).
 *
 * Groom-safe by construction: tenant_email_template_overrides is tenant config
 * (like market_benchmarks / t11 sources) — the groom sweep never touches it.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

interface OverrideSeed {
  id: string; // fixed t14 UUID
  templateKey: string;
  subjectOverride: string | null;
  slotOverrides: Record<string, string>;
  enabled: boolean;
}

const OVERRIDES: OverrideSeed[] = [
  {
    id: "00000000-0000-4014-8000-00000a140001",
    templateKey: "candidate.application_received",
    subjectOverride: "Kyndryl — we’ve received your application for {positionTitle}",
    slotOverrides: {
      signOff: "— The {companyName} Talent Acquisition team",
      footer:
        "This is an automated message from Kyndryl. Please don’t reply — a recruiter will be your point of contact from here.",
    },
    enabled: true,
  },
  {
    id: "00000000-0000-4014-8000-00000a140002",
    templateKey: "candidate.interview_invitation",
    subjectOverride: null,
    slotOverrides: {
      signOff: "— The {companyName} Talent Acquisition team",
    },
    enabled: true,
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
    console.log(`Seeding ${OVERRIDES.length} email-copy overrides into ${TENANT_SLUG} (${tid})`);

    for (const o of OVERRIDES) {
      // Delete by fixed id AND by the (tenant, template_key) unique key so a
      // re-run (or a prior hand-edit) can never trip the unique constraint.
      await poolSql`
        DELETE FROM public.tenant_email_template_overrides
        WHERE id = ${o.id}
           OR (tenant_id = ${tid} AND template_key = ${o.templateKey})
      `;
      await poolSql`
        INSERT INTO public.tenant_email_template_overrides
          (id, tenant_id, template_key, subject_override, slot_overrides, enabled, updated_at)
        VALUES
          (${o.id}, ${tid}, ${o.templateKey}, ${o.subjectOverride},
           ${JSON.stringify(o.slotOverrides)}::jsonb, ${o.enabled}, now())
      `;
      console.log(
        `  ✓ ${o.templateKey} → ${Object.keys(o.slotOverrides).length} slot(s)` +
          `${o.subjectOverride ? " + subject" : ""}`,
      );
    }

    console.log("Email-copy overrides seeded.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-t14-email-overrides failed:", err);
  process.exit(1);
});
