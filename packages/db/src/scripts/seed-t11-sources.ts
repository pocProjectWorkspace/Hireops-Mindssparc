/**
 * T1.1 / G04 sourcing-channel registry seed — a few CONFIGURED channels for
 * the demo tenant (kyndryl-poc) so /admin/sources and the recruiter source
 * views land populated. These are CONFIG rows over the fixed application_source
 * enum, not live ingestion: `ingestion_mode` honestly separates a
 * portal/manual channel from a connector work package.
 *
 * NAMESPACE: every seeded row carries config.seededBy = 't11' so the block is
 * identifiable/idempotent-cleanable. Keyed on (tenant_id, source_enum) —
 * a second run refreshes labels/flags, never duplicates.
 *
 * DISJOINT from the t11 test suite: the test exercises the 'whatsapp' channel,
 * which this seed deliberately does NOT seed, so a test run never clobbers seed
 * data and vice-versa.
 *
 * Run:
 *   pnpm db:seed:t11-sources
 *
 * Requires: DATABASE_URL in .env, and the kyndryl-poc tenant (db:migrate).
 *
 * Groom-safe by construction: tenant_application_sources is in NO groom residue
 * class (it is tenant config, like market_benchmarks) — the groom sweep never
 * touches it.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TENANT_SLUG = "kyndryl-poc";

type IngestionMode = "manual" | "connector_pending";

interface SourceSeed {
  sourceEnum: string;
  label: string;
  enabled: boolean;
  ingestionMode: IngestionMode;
  config: Record<string, string>;
  notes: string | null;
}

// A realistic mix: the channels that actually flow today are 'manual' (the
// public career-site apply form, referrals, partner submissions, recruiter
// attribution); the automated-pull channels are honestly 'connector_pending'.
const SOURCES: SourceSeed[] = [
  {
    sourceEnum: "career_site",
    label: "Careers site",
    enabled: true,
    ingestionMode: "manual",
    config: { detail: "careers" },
    notes: "Public apply form on the branded careers page.",
  },
  {
    sourceEnum: "referral",
    label: "Employee referrals",
    enabled: true,
    ingestionMode: "manual",
    config: {},
    notes: "Internal referral submissions.",
  },
  {
    sourceEnum: "partner_empanelled",
    label: "Empanelled partners",
    enabled: true,
    ingestionMode: "manual",
    config: {},
    notes: "Empanelled agencies submitting via the partner portal.",
  },
  {
    sourceEnum: "job_board",
    label: "Job boards (LinkedIn / Naukri)",
    enabled: true,
    ingestionMode: "connector_pending",
    config: { detail: "LinkedIn, Naukri" },
    notes: "Channel configured — automated ingestion is a connector work package.",
  },
  {
    sourceEnum: "agency_search",
    label: "Recruiter search",
    enabled: true,
    ingestionMode: "manual",
    config: {},
    notes: "Recruiter-initiated passive sourcing (attribution entered by the recruiter).",
  },
  {
    sourceEnum: "talent_pool",
    label: "Talent pool (silver medallists)",
    enabled: false,
    ingestionMode: "connector_pending",
    config: {},
    notes: "Phase-2 re-contact channel — configured but not yet enabled.",
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
    console.log(`Seeding ${SOURCES.length} sourcing channels into ${TENANT_SLUG} (${tid})`);

    for (const s of SOURCES) {
      const config = { ...s.config, seededBy: "t11" };
      await poolSql`
        INSERT INTO public.tenant_application_sources
          (tenant_id, source_enum, label, enabled, ingestion_mode, config, notes, updated_at)
        VALUES
          (${tid}, ${s.sourceEnum}::application_source, ${s.label}, ${s.enabled},
           ${s.ingestionMode}, ${JSON.stringify(config)}::jsonb, ${s.notes}, now())
        ON CONFLICT (tenant_id, source_enum) DO UPDATE SET
          label          = EXCLUDED.label,
          enabled        = EXCLUDED.enabled,
          ingestion_mode = EXCLUDED.ingestion_mode,
          config         = EXCLUDED.config,
          notes          = EXCLUDED.notes,
          updated_at     = now()
      `;
      console.log(
        `  ✓ ${s.sourceEnum} → “${s.label}” (${s.enabled ? "enabled" : "disabled"}, ${s.ingestionMode})`,
      );
    }

    console.log("Sourcing channels seeded.");
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error("seed-t11-sources failed:", err);
  process.exit(1);
});
