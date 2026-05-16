import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Partner empanelment status. Drives every downstream behaviour difference
 * between full-portal and email-only partners.
 *
 * - empanelled: signed MSA, full portal access
 * - ad_hoc:     spot vendor, email-only intake, no portal
 */
export const partnerTierEnum = pgEnum("partner_tier", ["empanelled", "ad_hoc"]);
export type PartnerTier = (typeof partnerTierEnum.enumValues)[number];
