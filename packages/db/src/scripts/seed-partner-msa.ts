import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

/**
 * Partner MSA demo seed — gives the empanelled partner org its LIVE commercial
 * terms so the partner portal's Commercials tab has something to render.
 *
 * WHY THIS EXISTS. db:seed:partner-demo is PARTNER-01 era: it creates the org,
 * the portal login and two assignments, but no partner_msa row — that table
 * arrived with P2. Without a live MSA:
 *   - the portal's Commercials tab renders empty, and
 *   - partnerSubmitCandidate falls back to its hardcoded 90-day exclusivity
 *     instead of the org's agreed window.
 * The internal UI can set one (Partners → org → upsertPartnerMsa), but a
 * hand-clicked row does not survive a reseed, so it belongs in a script.
 *
 * Run (AFTER db:seed:partner-demo, which creates the org this points at):
 *   pnpm --filter @hireops/db db:seed:partner-msa
 *   pnpm --filter @hireops/db db:seed:partner-msa -- --undo
 *
 * IDEMPOTENT. One deterministic id in partner-demo's a6xx namespace (…a620),
 * upserted on conflict. The table carries a PARTIAL UNIQUE index — one live row
 * per org WHERE effective_to IS NULL — so re-running never opens a second live
 * row, and --undo removes precisely this row and nothing else.
 *
 * Terms below are illustrative demo values, not a real commercial agreement.
 */

const TENANT_SLUG = "kyndryl-poc";

// partner-demo's org (…a601). This seed deliberately does NOT create an org —
// if partner-demo hasn't run there is nothing to attach terms to, and silently
// inventing a second org would give the portal two to choose between.
const PARTNER_ORG = "00000000-0000-4000-8000-00000000a601";
const MSA_ID = "00000000-0000-4000-8000-00000000a620";

// 8.5% of CTC, 120-day org-wide exclusivity, 25% held back to the end of
// probation, 90-day replacement guarantee. fee_model is text + CHECK
// (percentage_ctc | flat_per_hire).
const TERMS = {
  feeModel: "percentage_ctc",
  feePercent: "8.5",
  feeCurrency: "INR",
  exclusivityWindowDays: 120,
  exclusivityScope: "org_wide",
  probationHoldbackPercent: "25",
  replacementGuaranteeDays: 90,
} as const;

async function main(): Promise<void> {
  const undo = process.argv.includes("--undo");

  // Dynamic import so dotenv (above) runs before client.ts reads DATABASE_URL
  // at module init — the pattern every seed script here uses.
  const { sql: poolSql } = await import("../client");

  try {
    const [tenant] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!tenant) {
      console.error(`tenant ${TENANT_SLUG} not found; run db:migrate first.`);
      process.exit(2);
    }

    if (undo) {
      const gone = await poolSql`
        DELETE FROM public.partner_msa
        WHERE id = ${MSA_ID} AND tenant_id = ${tenant.id}
        RETURNING id
      `;
      console.log(gone.length ? `  ✓ removed MSA ${MSA_ID}` : "  · no MSA row to remove");
      return;
    }

    const [org] = await poolSql<{ id: string; name: string }[]>`
      SELECT id, name FROM public.partner_orgs
      WHERE id = ${PARTNER_ORG} AND tenant_id = ${tenant.id}
      LIMIT 1
    `;
    if (!org) {
      console.error(
        `partner org ${PARTNER_ORG} not found in ${TENANT_SLUG}.\n` +
          "Run `pnpm --filter @hireops/db db:seed:partner-demo` first — this seed\n" +
          "attaches commercial terms to that org, it does not create one.",
      );
      process.exit(2);
    }

    // Close any OTHER live row first. The partial unique index (one live row
    // per org) would otherwise reject this insert, and a hand-made row from the
    // internal UI is exactly the case that hits it.
    const closed = await poolSql`
      UPDATE public.partner_msa
      SET effective_to = now(), updated_at = now()
      WHERE tenant_id = ${tenant.id}
        AND partner_org_id = ${org.id}
        AND effective_to IS NULL
        AND id <> ${MSA_ID}
      RETURNING id
    `;
    if (closed.length) {
      console.log(`  · closed ${closed.length} pre-existing live MSA row(s) for ${org.name}`);
    }

    await poolSql`
      INSERT INTO public.partner_msa
        (id, tenant_id, partner_org_id, fee_model, fee_percent, fee_currency,
         exclusivity_window_days, exclusivity_scope, probation_holdback_percent,
         replacement_guarantee_days, effective_from, effective_to, updated_at)
      VALUES
        (${MSA_ID}, ${tenant.id}, ${org.id}, ${TERMS.feeModel}, ${TERMS.feePercent},
         ${TERMS.feeCurrency}, ${TERMS.exclusivityWindowDays}, ${TERMS.exclusivityScope},
         ${TERMS.probationHoldbackPercent}, ${TERMS.replacementGuaranteeDays},
         now(), NULL, now())
      ON CONFLICT (id) DO UPDATE SET
        fee_model                  = EXCLUDED.fee_model,
        fee_percent                = EXCLUDED.fee_percent,
        fee_currency               = EXCLUDED.fee_currency,
        exclusivity_window_days    = EXCLUDED.exclusivity_window_days,
        exclusivity_scope          = EXCLUDED.exclusivity_scope,
        probation_holdback_percent = EXCLUDED.probation_holdback_percent,
        replacement_guarantee_days = EXCLUDED.replacement_guarantee_days,
        effective_to               = NULL,
        updated_at                 = now()
    `;

    console.log(`\nPartner MSA seeded for ${org.name}:`);
    console.log(`  fee:          ${TERMS.feePercent}% of CTC (${TERMS.feeCurrency})`);
    console.log(`  exclusivity:  ${TERMS.exclusivityWindowDays} days, ${TERMS.exclusivityScope}`);
    console.log(`  holdback:     ${TERMS.probationHoldbackPercent}% to end of probation`);
    console.log(`  replacement:  ${TERMS.replacementGuaranteeDays}-day guarantee`);
    console.log(
      "\nTerms are on file, so a fee now accrues (and computes correctly) when a" +
        "\ncandidate this partner sourced accepts an offer. Visible on the INTERNAL" +
        "\npage /partners/<orgId>. The PARTNER's own Commercials tab reads fee rows," +
        "\nnot the MSA, so it stays empty until such a hire actually happens.",
    );
  } finally {
    const { sql: poolSql } = await import("../client");
    await poolSql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("seed-partner-msa failed:", err);
  process.exit(1);
});
