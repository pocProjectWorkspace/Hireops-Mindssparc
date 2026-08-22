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
 *
 * 'ai_async' (N4.1 / migration 0119) is the asynchronous AI first round: a
 * fixed question set answered one at a time, by voice with a typed fallback.
 * It is a MODE and not a separate screening entity, so the round inherits
 * scheduling, completed_at/cancelled_at and interview-health reporting. The
 * value is CHECK-constrained in THREE tables (interviews, interview_plans,
 * tenant_interview_round_template) and this enum is the fourth site — all
 * four move together, because a widened CHECK with a stale enum here means
 * the api rejects rows the database accepts.
 */
export const interviewModeSchema = z.enum(["video", "onsite", "phone", "ai_async"]);
export type InterviewMode = z.infer<typeof interviewModeSchema>;

export const interviewScorecardTemplateSchema = z.enum(["technical", "manager", "hr", "general"]);
export type InterviewScorecardTemplate = z.infer<typeof interviewScorecardTemplateSchema>;

export const interviewStatusSchema = z.enum(["scheduled", "completed", "cancelled", "no_show"]);
export type InterviewStatus = z.infer<typeof interviewStatusSchema>;
