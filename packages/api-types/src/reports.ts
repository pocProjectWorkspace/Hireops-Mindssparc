/**
 * Reporting semantic layer — the shared filter contract (R0.1).
 *
 * One filter set for every report, so "applications in period P, in BU B,
 * on requisition R" is the same question on every surface. The server-side
 * SQL builders live in `apps/api/src/lib/reports/dimensions.ts`; this is
 * the wire schema they mirror.
 *
 * Every field is optional — `{}` means "all time, whole tenant", which is
 * the default every report opens with.
 *
 * Deliberately absent: location (no locations table — free text on
 * `positions.primary_location`) and department (business unit IS the
 * department axis). See the reporting build plan §2.3.
 */

import { z } from "zod";

import { applicationSourceSchema, applicationStageSchema } from "./enums";

export const reportFiltersSchema = z.object({
  /** ISO datetime lower bound on applications.created_at (inclusive). */
  from: z.string().datetime().optional(),
  /** ISO datetime upper bound on applications.created_at (inclusive). */
  to: z.string().datetime().optional(),
  /** Business unit, resolved through requisitions → positions. */
  businessUnitId: z.string().uuid().optional(),
  /** A single requisition. */
  requisitionId: z.string().uuid().optional(),
  /** The application's assigned recruiter (tenant_user_memberships.id). */
  recruiterMembershipId: z.string().uuid().optional(),
  /** Acquisition channel. */
  source: applicationSourceSchema.optional(),
  /** Current pipeline stage. */
  stage: applicationStageSchema.optional(),
});

export type ReportFilters = z.infer<typeof reportFiltersSchema>;
