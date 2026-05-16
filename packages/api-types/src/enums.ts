import { z } from "zod";

/**
 * Mirrors of the Postgres enums in @hireops/db. Re-declared here as Zod
 * enums because @hireops/db is a service-side dep and the frontend (which
 * consumes @hireops/api-types) shouldn't pull in drizzle-orm just to
 * validate a stage string.
 *
 * KEEP IN SYNC with packages/db/src/schema/application-stage.ts and
 * application-source.ts. A typecheck won't catch divergence; the test
 * suite asserts both sides agree.
 */

export const applicationStageSchema = z.enum([
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);
export type ApplicationStage = z.infer<typeof applicationStageSchema>;

export const applicationSourceSchema = z.enum([
  "career_site",
  "referral",
  "partner_empanelled",
  "partner_adhoc",
  "job_board",
  "agency_search",
  "talent_pool",
  "whatsapp",
]);
export type ApplicationSource = z.infer<typeof applicationSourceSchema>;
