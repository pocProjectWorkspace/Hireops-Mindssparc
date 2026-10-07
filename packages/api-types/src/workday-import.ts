/**
 * "Import from Workday" — PoC PREVIEW contracts + the built-in sample export.
 *
 * HONESTY: there is NO live Workday connection. The preview reads a BUILT-IN
 * sample Workday requisition export (WORKDAY_SAMPLE_REQUISITIONS below, using
 * standard Workday report field names). What IS real: the field mapping is
 * validated server-side against the tenant's actual business units, members and
 * comp bands, and "Import as drafts" creates real DRAFT requisitions through the
 * same creation path as the requisition wizard.
 *
 * Provenance (no migration): the Workday Job Requisition ID is recorded in the
 * metadata of the requisition's FIRST state transition (→ draft), under
 * `source: "workday_import_preview"`. That row is also the idempotency key.
 */

import { z } from "zod";

/** metadata.source value on the creating requisition_state_transitions row. */
export const WORKDAY_IMPORT_SOURCE = "workday_import_preview" as const;

/** One row of the sample Workday requisition export (standard field names). */
export interface WorkdaySampleRequisition {
  "Job Requisition ID": string;
  "Job Posting Title": string;
  "Job Profile": string;
  "Supervisory Organization": string;
  Location: string;
  "Worker Type": string;
  "Time Type": string;
  "Number of Openings": number;
  /** Resolved to an ISO date relative to "today" when the preview is built. */
  targetHireDateOffsetDays: number;
  "Hiring Manager": string;
  Recruiter: string;
  "Compensation Grade": string;
  Reason: string;
  /** Job description summary lines (seed the draft JD). */
  jobDescription: string[];
  /** Skills (seed jd_skills on the draft JD version). */
  skills: string[];
}

export const WORKDAY_SAMPLE_REQUISITIONS: readonly WorkdaySampleRequisition[] = [
  {
    "Job Requisition ID": "JR-24117",
    "Job Posting Title": "Cash Application Analyst",
    "Job Profile": "Accounts Receivable Analyst",
    "Supervisory Organization": "GBS India — Order to Cash",
    Location: "Hyderabad, India",
    "Worker Type": "Employee",
    "Time Type": "Full time",
    "Number of Openings": 2,
    targetHireDateOffsetDays: 42,
    "Hiring Manager": "Suresh Venkataraman",
    Recruiter: "Nisha Balakrishnan",
    "Compensation Grade": "IN09",
    Reason: "Backfill",
    jobDescription: [
      "Apply incoming customer receipts (bank, lockbox, cheque) to open invoices in SAP accurately and on time.",
      "Investigate and resolve unapplied and unidentified cash with customers and collections teams.",
      "Perform daily bank reconciliations and clear suspense accounts.",
      "Support month-end close with AR ageing, cash reports and reconciliations.",
    ],
    skills: [
      "Cash application",
      "Bank reconciliation",
      "SAP FI-AR",
      "Advanced Excel",
      "Accounts receivable",
    ],
  },
  {
    "Job Requisition ID": "JR-24121",
    "Job Posting Title": "Accounts Payable Senior Analyst",
    "Job Profile": "Accounts Payable Analyst",
    "Supervisory Organization": "GBS India — Procure to Pay",
    Location: "Hyderabad, India",
    "Worker Type": "Employee",
    "Time Type": "Full time",
    "Number of Openings": 1,
    targetHireDateOffsetDays: 35,
    "Hiring Manager": "Chandramouli Rao",
    Recruiter: "Nisha Balakrishnan",
    "Compensation Grade": "IN12",
    Reason: "New position",
    jobDescription: [
      "Own end-to-end invoice processing including 2-way and 3-way PO matching.",
      "Resolve vendor queries and payment blocks; reconcile vendor statements.",
      "Prepare payment proposals and support weekly payment runs.",
      "Drive accruals, AP ageing and month-end close activities; coach junior analysts.",
    ],
    skills: [
      "Invoice processing",
      "3-way match",
      "Vendor reconciliation",
      "SAP FI-AP",
      "Month-end close",
    ],
  },
  {
    "Job Requisition ID": "JR-24130",
    "Job Posting Title": "SAP FICO Consultant",
    "Job Profile": "SAP Finance Consultant",
    "Supervisory Organization": "GBS India — Finance Systems",
    Location: "Hyderabad, India",
    "Worker Type": "Employee",
    "Time Type": "Full time",
    "Number of Openings": 1,
    targetHireDateOffsetDays: 56,
    "Hiring Manager": "Suman Reddy",
    Recruiter: "Nisha Balakrishnan",
    "Compensation Grade": "IN14",
    Reason: "New position",
    jobDescription: [
      "Configure and support SAP FI/CO (GL, AP, AR, asset accounting, cost centre accounting).",
      "Translate GBS finance process requirements into functional specifications.",
      "Lead testing, cut-over and hypercare for finance system changes.",
      "Partner with Order-to-Cash and Procure-to-Pay towers on automation and controls.",
    ],
    skills: ["SAP FI/CO", "S/4HANA Finance", "General ledger", "Functional specifications", "UAT"],
  },
];

/** The Workday fields shown as preview columns, in order. */
export const WORKDAY_PREVIEW_COLUMNS = [
  "Job Requisition ID",
  "Job Posting Title",
  "Job Profile",
  "Supervisory Organization",
  "Location",
  "Worker Type",
  "Time Type",
  "Number of Openings",
  "Target Hire Date",
  "Hiring Manager",
  "Recruiter",
  "Compensation Grade",
  "Reason",
] as const;

export const workdayMappingStatusSchema = z.enum(["mapped", "needs_review", "not_imported"]);
export type WorkdayMappingStatus = z.infer<typeof workdayMappingStatusSchema>;

export const workdayFieldMappingSchema = z.object({
  workdayField: z.string(),
  workdayValue: z.string(),
  hireopsField: z.string(),
  /** What HireOps will write (e.g. the matched band name). */
  hireopsValue: z.string().nullable(),
  status: workdayMappingStatusSchema,
  note: z.string().nullable(),
});
export type WorkdayFieldMapping = z.infer<typeof workdayFieldMappingSchema>;

export const workdayPreviewRowSchema = z.object({
  jobRequisitionId: z.string(),
  /** Workday field name → display value (incl. the resolved Target Hire Date). */
  fields: z.record(z.string(), z.string()),
  jobDescription: z.array(z.string()),
  skills: z.array(z.string()),
  mapping: z.array(workdayFieldMappingSchema),
  needsReviewCount: z.number().int(),
  alreadyImported: z.object({ requisitionId: z.string().uuid() }).nullable(),
});
export type WorkdayPreviewRow = z.infer<typeof workdayPreviewRowSchema>;

// ─────────────── previewWorkdayRequisitionImport ───────────────

export const previewWorkdayRequisitionImportOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(workdayPreviewRowSchema),
});
export type PreviewWorkdayRequisitionImportOutput = z.infer<
  typeof previewWorkdayRequisitionImportOutputSchema
>;

// ─────────────── importWorkdayRequisitions ───────────────

export const importWorkdayRequisitionsInputSchema = z.object({
  jobRequisitionIds: z.array(z.string().min(1).max(40)).min(1).max(20),
});
export type ImportWorkdayRequisitionsInput = z.infer<typeof importWorkdayRequisitionsInputSchema>;

export const importWorkdayRequisitionsOutputSchema = z.object({
  results: z.array(
    z.object({
      jobRequisitionId: z.string(),
      title: z.string(),
      outcome: z.enum(["created", "already_imported", "skipped"]),
      requisitionId: z.string().uuid().nullable(),
      /** Why a row was skipped (e.g. an active position with that title exists). */
      message: z.string().nullable(),
    }),
  ),
  createdCount: z.number().int(),
});
export type ImportWorkdayRequisitionsOutput = z.infer<typeof importWorkdayRequisitionsOutputSchema>;
