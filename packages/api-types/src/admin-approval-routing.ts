import { z } from "zod";

/**
 * T1.3 (G13) — configurable approval routing, OPTION (b): admin authoring of the
 * approval matrix that the requisition / offer approval resolvers actually read.
 *
 * Scope is deliberately narrow and honest: a matrix carries exactly ONE approver
 * step. The admin configures WHO approves (a role) and WHEN the policy takes
 * effect (effective-from + optional effective-to). Multi-step routing is NOT
 * authored here — a second step would be silently ignored by the decision spine,
 * which is exactly the G13 config-lie this ticket exists to kill. The resolvers
 * derive their `resolved_steps` from the currently-effective matrix's rules, so
 * changing the approver role here changes who the platform actually routes to.
 *
 * The approver role is constrained to the two roles the decision procedures
 * accept (REQUISITION_APPROVAL_DECIDE_ROLES / OFFER_APPROVAL_DECIDE_ROLES):
 * hr_head and admin. Authoring any other role would produce an unresolvable
 * chain, so the enum is the guardrail.
 */

/** The two subject types an approval matrix can target. */
export const APPROVAL_MATRIX_SUBJECT_TYPES = ["requisition", "offer"] as const;
export const approvalMatrixSubjectTypeSchema = z.enum(APPROVAL_MATRIX_SUBJECT_TYPES);
export type ApprovalMatrixSubjectType = z.infer<typeof approvalMatrixSubjectTypeSchema>;

/**
 * The only approver roles a matrix may name — the roles the decision procedures
 * accept. Keep in lockstep with REQUISITION_APPROVAL_DECIDE_ROLES /
 * OFFER_APPROVAL_DECIDE_ROLES in the api router.
 */
export const APPROVAL_MATRIX_APPROVER_ROLES = ["hr_head", "admin"] as const;
export const approvalMatrixApproverRoleSchema = z.enum(APPROVAL_MATRIX_APPROVER_ROLES);
export type ApprovalMatrixApproverRole = z.infer<typeof approvalMatrixApproverRoleSchema>;

export const APPROVER_ROLE_LABELS: Record<ApprovalMatrixApproverRole, string> = {
  hr_head: "HR Head",
  admin: "Admin",
};

/** A parseable date string (ISO or `datetime-local`). */
const dateStringSchema = z
  .string()
  .refine((s) => s.trim().length > 0 && !Number.isNaN(Date.parse(s)), "Enter a valid date");

// ─────────────────────── listApprovalMatrices ───────────────────────

export const listApprovalMatricesInputSchema = z.object({
  subjectType: approvalMatrixSubjectTypeSchema.optional(),
});
export type ListApprovalMatricesInput = z.infer<typeof listApprovalMatricesInputSchema>;

/**
 * One authored matrix as the admin surface sees it. `approverRole` is derived
 * from `rules.steps[0].approver_ref` (a plain string — a legacy matrix could
 * name a role outside the enum, and we surface it rather than throw).
 * `isActiveNow` is the effective-window test against the server clock.
 */
export const approvalMatrixRowSchema = z.object({
  id: z.string().uuid(),
  subjectType: approvalMatrixSubjectTypeSchema,
  name: z.string(),
  approverRole: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  isActiveNow: z.boolean(),
  createdAt: z.string(),
});
export type ApprovalMatrixRow = z.infer<typeof approvalMatrixRowSchema>;

export const listApprovalMatricesOutputSchema = z.object({
  matrices: z.array(approvalMatrixRowSchema),
});
export type ListApprovalMatricesOutput = z.infer<typeof listApprovalMatricesOutputSchema>;

// ─────────────────────── upsertApprovalMatrix ───────────────────────

export const upsertApprovalMatrixInputSchema = z.object({
  id: z.string().uuid().optional(),
  subjectType: approvalMatrixSubjectTypeSchema,
  name: z.string().trim().min(1, "Give the policy a name").max(120),
  approverRole: approvalMatrixApproverRoleSchema,
  effectiveFrom: dateStringSchema,
  effectiveTo: dateStringSchema.nullable().optional(),
});
export type UpsertApprovalMatrixInput = z.infer<typeof upsertApprovalMatrixInputSchema>;

export const upsertApprovalMatrixOutputSchema = z.object({
  id: z.string().uuid(),
});
export type UpsertApprovalMatrixOutput = z.infer<typeof upsertApprovalMatrixOutputSchema>;
