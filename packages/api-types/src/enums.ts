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

/**
 * Interview mode + scorecard template + status (Wave B, INT-01/02). Mirror
 * the text + CHECK constraints on interview_plans / interviews. KEEP IN SYNC
 * with packages/db/src/schema/interview-plans.ts + interviews.ts.
 */
export const interviewModeSchema = z.enum(["video", "onsite", "phone"]);
export type InterviewMode = z.infer<typeof interviewModeSchema>;

export const interviewScorecardTemplateSchema = z.enum(["technical", "manager", "hr", "general"]);
export type InterviewScorecardTemplate = z.infer<typeof interviewScorecardTemplateSchema>;

export const interviewStatusSchema = z.enum(["scheduled", "completed", "cancelled", "no_show"]);
export type InterviewStatus = z.infer<typeof interviewStatusSchema>;
