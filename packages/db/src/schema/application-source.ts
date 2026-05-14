import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Channel that introduced a candidate into the pipeline. One row per
 * application records the immediate channel; a single candidate can
 * apply to multiple reqs via different channels so this lives on the
 * application, not the candidate (the candidate also stores it for the
 * first contact channel — see candidates.source).
 *
 * Aligned with requirements.md §5.3 sourcing taxonomy.
 *
 * - career_site         — Kyndryl-branded apply page (§5.3 row 2)
 * - referral            — internal referral submission (§5.3 row 5)
 * - partner_empanelled  — empanelled partner submitted via full portal (§6)
 * - partner_adhoc       — ad-hoc partner sent CV via email (§6.5)
 * - job_board           — LinkedIn / Naukri / Indeed inbound (§5.3 row 1)
 * - agency_search       — recruiter-initiated outreach (passive sourcing)
 * - talent_pool         — silver-medallist recontact (§5.3 row 7, Phase 2)
 * - whatsapp            — WhatsApp-initiated apply (§5.3 row 9)
 */
export const applicationSourceEnum = pgEnum("application_source", [
  "career_site",
  "referral",
  "partner_empanelled",
  "partner_adhoc",
  "job_board",
  "agency_search",
  "talent_pool",
  "whatsapp",
]);

export type ApplicationSource = (typeof applicationSourceEnum.enumValues)[number];
