/**
 * PC-13 — Workday handoff record ("the selected candidate goes back to Workday").
 *
 * Boundary: Workday keeps approvals + offers; HireOps hands the offer-ready
 * candidate back. Until a live connector exists the handoff is a FILE (CSV /
 * JSON) a recruiter or HR user downloads — built from the same data the
 * `hire_employee` row in workday_sync_outbox already carries, enriched with the
 * fields that payload doesn't snapshot (candidate id, grade, hiring manager,
 * recruiter, source, Workday requisition id).
 *
 * PLATFORM DEFAULT, not client-specific: WORKDAY_HANDOFF_DEFAULT_COLUMNS is the
 * one place the column keys, their Workday-friendly headers and their ORDER
 * are defined. A future per-tenant field mapping replaces this list (same keys,
 * different headers / subset / order) without touching the record builder.
 */

import { z } from "zod";

/** Ordered column list — key → Workday-friendly header. Platform default. */
export const WORKDAY_HANDOFF_DEFAULT_COLUMNS = [
  { key: "candidateId", header: "Candidate ID" },
  { key: "legalName", header: "Legal Name" },
  { key: "email", header: "Email" },
  { key: "phone", header: "Phone" },
  { key: "jobRequisitionId", header: "Job Requisition ID" },
  { key: "jobTitle", header: "Position / Job Title" },
  { key: "businessUnit", header: "Business Unit" },
  { key: "location", header: "Location" },
  { key: "grade", header: "Grade / Band" },
  { key: "proposedStartDate", header: "Proposed Start Date" },
  { key: "basePay", header: "Base Pay" },
  { key: "currency", header: "Currency" },
  { key: "hiringManager", header: "Hiring Manager" },
  { key: "recruiter", header: "Recruiter" },
  { key: "source", header: "Source" },
  { key: "handoffStatus", header: "Handoff Status" },
  { key: "workdayReference", header: "Workday Reference" },
  { key: "hireopsApplicationId", header: "HireOps Application ID" },
  { key: "hireopsRequisitionId", header: "HireOps Requisition ID" },
  { key: "generatedAt", header: "Generated At" },
] as const;

export type WorkdayHandoffColumnKey = (typeof WORKDAY_HANDOFF_DEFAULT_COLUMNS)[number]["key"];

export interface WorkdayHandoffColumn {
  key: WorkdayHandoffColumnKey;
  header: string;
}

/** Any id a Postgres `uuid` column holds (zod 4 `.uuid()` is RFC-strict; see learning.ts). */
const pgUuid = z.guid();

const cell = z.string().nullable();

/** One handoff record. Every value is a display-ready string (or null = blank). */
export const workdayHandoffRecordSchema = z.object({
  candidateId: cell,
  legalName: cell,
  email: cell,
  phone: cell,
  jobRequisitionId: cell,
  jobTitle: cell,
  businessUnit: cell,
  location: cell,
  grade: cell,
  proposedStartDate: cell,
  basePay: cell,
  currency: cell,
  hiringManager: cell,
  recruiter: cell,
  source: cell,
  handoffStatus: cell,
  workdayReference: cell,
  hireopsApplicationId: cell,
  hireopsRequisitionId: cell,
  generatedAt: cell,
});
export type WorkdayHandoffRecord = z.infer<typeof workdayHandoffRecordSchema>;

/**
 * Handoff lifecycle as the recruiter sees it:
 *   - none           — no live offer; nothing to hand off.
 *   - offer_ready    — offer drafted / extended but not accepted (approvals sit
 *                      in Workday): record can be generated, marked pre-approval.
 *   - ready          — offer accepted; hire record queued for Workday.
 *   - sent_simulated — drained by the PoC simulator (no live Workday call).
 *   - sent           — dispatched by a real connector (future).
 *   - failed         — the dispatch failed; see Integration Health.
 */
export const workdayHandoffStatusSchema = z.enum([
  "none",
  "offer_ready",
  "ready",
  "sent_simulated",
  "sent",
  "failed",
]);
export type WorkdayHandoffStatus = z.infer<typeof workdayHandoffStatusSchema>;

export const WORKDAY_HANDOFF_STATUS_LABELS: Record<WorkdayHandoffStatus, string> = {
  none: "Not ready",
  offer_ready: "Offer-ready (pre-approval)",
  ready: "Ready for Workday",
  sent_simulated: "Sent to Workday (simulated)",
  sent: "Sent to Workday",
  failed: "Workday handoff failed",
};

// ─────────────── getWorkdayHandoff (one application) ───────────────

export const getWorkdayHandoffInputSchema = z.object({
  applicationId: pgUuid,
});
export type GetWorkdayHandoffInput = z.infer<typeof getWorkdayHandoffInputSchema>;

export const getWorkdayHandoffOutputSchema = z.object({
  applicationId: pgUuid,
  status: workdayHandoffStatusSchema,
  statusLabel: z.string(),
  /** workday_sync_outbox row id, null until the hire record is queued. */
  outboxId: pgUuid.nullable(),
  queuedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  /** Workday-side reference (WID) from the (simulated) response. */
  workdayReference: z.string().nullable(),
  workdayReferenceDescriptor: z.string().nullable(),
  /** The drain worker that processed the row (claimed_by). */
  processedBy: z.string().nullable(),
  columns: z.array(z.object({ key: z.string(), header: z.string() })),
  record: workdayHandoffRecordSchema.nullable(),
  /** RFC-4180 CSV (header + one row), null when status = none. */
  csv: z.string().nullable(),
  /** Header-keyed JSON object, null when status = none. */
  json: z.record(z.string(), z.string().nullable()).nullable(),
  filenameBase: z.string(),
});
export type GetWorkdayHandoffOutput = z.infer<typeof getWorkdayHandoffOutputSchema>;

// ─────────────── exportWorkdayHandoffs (bulk CSV) ───────────────

export const WORKDAY_HANDOFF_EXPORT_MAX_ROWS = 2000;

export const exportWorkdayHandoffsInputSchema = z.object({
  requisitionId: pgUuid.optional(),
  /** pending = queued / processing; sent = simulated or sent. */
  status: z.enum(["all", "pending", "sent", "failed"]).default("all"),
  /** Inclusive YYYY-MM-DD bounds on the queued date (UTC). */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type ExportWorkdayHandoffsInput = z.input<typeof exportWorkdayHandoffsInputSchema>;

export const exportWorkdayHandoffsOutputSchema = z.object({
  csv: z.string(),
  rowCount: z.number().int(),
  truncated: z.boolean(),
  filename: z.string(),
});
export type ExportWorkdayHandoffsOutput = z.infer<typeof exportWorkdayHandoffsOutputSchema>;
