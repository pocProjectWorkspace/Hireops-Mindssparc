/**
 * "Import from Workday" — contracts, the column alias table, upload limits and
 * the built-in DEMO sample export.
 *
 * HONESTY: there is NO live Workday connection. Requisitions arrive as a
 * Workday report EXPORT (CSV or XLSX) that a user uploads into the drawer, or —
 * for demos only — from the built-in sample (WORKDAY_SAMPLE_REQUISITIONS
 * below). Both paths become the same normalised WorkdayRequisitionRow and go
 * through the same server-side mapping, which is validated against the
 * tenant's actual business units, members and comp bands. "Import as drafts"
 * creates real DRAFT requisitions through the same creation path as the
 * requisition wizard.
 *
 * Provenance (no migration): the Workday Job Requisition ID is recorded in the
 * metadata of the requisition's FIRST state transition (→ draft), under
 * `source: "workday_import_preview"`. That row is also the idempotency key —
 * for the sample AND for uploads (same Workday id ⇒ "already imported").
 */

import { z } from "zod";

/** metadata.source value on the creating requisition_state_transitions row. */
export const WORKDAY_IMPORT_SOURCE = "workday_import_preview" as const;

// ─────────────── Upload limits ───────────────

/** Largest Workday export file accepted (raw bytes, before base64). */
export const WORKDAY_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** Most requisition (data) rows accepted from one export file. */
export const WORKDAY_UPLOAD_MAX_ROWS = 2000;
/** base64 length of a WORKDAY_UPLOAD_MAX_BYTES file (4 chars per 3 bytes, padded). */
export const WORKDAY_UPLOAD_MAX_BASE64_CHARS = Math.ceil(WORKDAY_UPLOAD_MAX_BYTES / 3) * 4;
/** File extensions the upload accepts (the file picker's `accept`). */
export const WORKDAY_UPLOAD_EXTENSIONS = [".csv", ".xlsx"] as const;

// ─────────────── Column alias table (platform default) ───────────────

/** The normalised requisition fields HireOps reads from a Workday export. */
export type WorkdayRequisitionFieldKey =
  | "jobRequisitionId"
  | "jobPostingTitle"
  | "jobProfile"
  | "supervisoryOrganization"
  | "location"
  | "workerType"
  | "timeType"
  | "numberOfOpenings"
  | "targetHireDate"
  | "hiringManager"
  | "recruiter"
  | "compensationGrade"
  | "reason"
  | "jobDescription"
  | "skills";

export interface WorkdayColumnSpec {
  key: WorkdayRequisitionFieldKey;
  /** Canonical Workday field name — shown as the preview column header. */
  label: string;
  /** A file without this column is rejected with an error naming it. */
  required: boolean;
  /**
   * Accepted header names (matched case-, punctuation- and
   * whitespace-insensitively). The label is always accepted too.
   */
  aliases: readonly string[];
}

/**
 * PLATFORM DEFAULT header aliases for common Workday requisition report column
 * names. A header that matches none of these is listed as "not imported" in
 * the preview. Aliases must not overlap between fields (pinned by a test).
 */
export const WORKDAY_COLUMN_ALIASES: readonly WorkdayColumnSpec[] = [
  {
    key: "jobRequisitionId",
    label: "Job Requisition ID",
    required: true,
    aliases: [
      "Job Requisition ID",
      "Requisition ID",
      "Job Req ID",
      "Req ID",
      "Job Requisition Number",
      "Requisition Number",
      "Job Requisition Reference ID",
    ],
  },
  {
    key: "jobPostingTitle",
    label: "Job Posting Title",
    required: true,
    aliases: [
      "Job Posting Title",
      "Posting Title",
      "Job Requisition Title",
      "Requisition Title",
      "Job Title",
      "Position Title",
      "Title",
    ],
  },
  {
    key: "jobProfile",
    label: "Job Profile",
    required: false,
    aliases: ["Job Profile", "Job Profile Name"],
  },
  {
    key: "supervisoryOrganization",
    label: "Supervisory Organization",
    required: false,
    aliases: [
      "Supervisory Organization",
      "Supervisory Organisation",
      "Supervisory Org",
      "Organization",
      "Organisation",
      "Department",
      "Business Unit",
    ],
  },
  {
    key: "location",
    label: "Location",
    required: false,
    aliases: [
      "Location",
      "Primary Location",
      "Primary Job Posting Location",
      "Job Location",
      "Work Location",
    ],
  },
  {
    key: "workerType",
    label: "Worker Type",
    required: false,
    aliases: ["Worker Type", "Employee Type"],
  },
  {
    key: "timeType",
    label: "Time Type",
    required: false,
    aliases: ["Time Type", "Full Part Time", "Full Time Part Time"],
  },
  {
    key: "numberOfOpenings",
    label: "Number of Openings",
    required: false,
    aliases: [
      "Number of Openings",
      "No of Openings",
      "Number of Openings Available",
      "Openings Available",
      "Openings",
      "Number of Positions",
      "Positions",
      "Headcount",
    ],
  },
  {
    key: "targetHireDate",
    label: "Target Hire Date",
    required: false,
    aliases: ["Target Hire Date", "Target Start Date", "Expected Start Date", "Start Date"],
  },
  {
    key: "hiringManager",
    label: "Hiring Manager",
    required: false,
    aliases: ["Hiring Manager", "Hiring Manager Name", "Hiring Managers", "Manager"],
  },
  {
    key: "recruiter",
    label: "Recruiter",
    required: false,
    aliases: ["Recruiter", "Primary Recruiter", "Recruiter Name", "Recruiters"],
  },
  {
    key: "compensationGrade",
    label: "Compensation Grade",
    required: false,
    aliases: [
      "Compensation Grade",
      "Compensation Grade Profile",
      "Comp Grade",
      "Grade",
      "Pay Grade",
      "Job Grade",
    ],
  },
  {
    key: "reason",
    label: "Reason",
    required: false,
    aliases: [
      "Reason",
      "Requisition Reason",
      "Job Requisition Reason",
      "Reason for Requisition",
      "Hire Reason",
    ],
  },
  {
    key: "jobDescription",
    label: "Job Description",
    required: false,
    aliases: [
      "Job Description",
      "Job Description Summary",
      "Job Posting Description",
      "Description",
      "Responsibilities",
    ],
  },
  {
    key: "skills",
    label: "Skills",
    required: false,
    aliases: ["Skills", "Required Skills", "Key Skills", "Skill"],
  },
];

/**
 * One requisition from a Workday export, normalised. Every scalar is the RAW
 * text from the file ("" when absent) — the mapper parses numbers and dates
 * and flags what it can't read, so preview and import never disagree.
 */
export interface WorkdayRequisitionRow {
  /** 1-based row number in the source sheet (sample: position in the list). */
  rowNumber: number;
  jobRequisitionId: string;
  jobPostingTitle: string;
  jobProfile: string;
  supervisoryOrganization: string;
  location: string;
  workerType: string;
  timeType: string;
  numberOfOpenings: string;
  targetHireDate: string;
  hiringManager: string;
  recruiter: string;
  compensationGrade: string;
  reason: string;
  jobDescription: string[];
  skills: string[];
}

// ─────────────── Built-in DEMO sample ───────────────

/** One row of the built-in demo sample export (standard field names). */
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
  /** 1-based row number in the source file (sample: position in the list). */
  rowNumber: z.number().int(),
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

/** A file row that can't be imported (missing id/title, duplicate id, …). */
export const workdayRowErrorSchema = z.object({
  rowNumber: z.number().int(),
  jobRequisitionId: z.string().nullable(),
  message: z.string(),
});
export type WorkdayRowError = z.infer<typeof workdayRowErrorSchema>;

// ─────────────── Upload file (base64 over tRPC) ───────────────

export const workdayUploadFileSchema = z.object({
  /** Original file name — the extension (.csv / .xlsx) picks the parser. */
  fileName: z.string().trim().min(1).max(255),
  /** File bytes, base64-encoded (≤ WORKDAY_UPLOAD_MAX_BYTES decoded). */
  contentBase64: z.string().min(1).max(WORKDAY_UPLOAD_MAX_BASE64_CHARS),
});
export type WorkdayUploadFile = z.infer<typeof workdayUploadFileSchema>;

// ─────────────── previewWorkdayRequisitionImport / …Upload ───────────────

export const previewWorkdayRequisitionImportOutputSchema = z.object({
  /** "sample" = the built-in demo export; "upload" = a user's export file. */
  source: z.enum(["sample", "upload"]),
  fileName: z.string().nullable(),
  columns: z.array(z.string()),
  rows: z.array(workdayPreviewRowSchema),
  /** Headers in the file that HireOps does not import (unknown or duplicate). */
  unmappedColumns: z.array(z.string()),
  /** Rows that can't be imported, with the reason. */
  rowErrors: z.array(workdayRowErrorSchema),
  counts: z.object({
    /** Importable rows (= rows.length). */
    total: z.number().int(),
    /** Not yet imported, every field ✓ mapped. */
    ready: z.number().int(),
    /** Not yet imported, at least one ⚠ field. */
    needsReview: z.number().int(),
    /** Workday id already imported into this workspace. */
    alreadyImported: z.number().int(),
    /** = rowErrors.length. */
    invalid: z.number().int(),
  }),
});
export type PreviewWorkdayRequisitionImportOutput = z.infer<
  typeof previewWorkdayRequisitionImportOutputSchema
>;

export const previewWorkdayRequisitionUploadInputSchema = z.object({
  file: workdayUploadFileSchema,
});
export type PreviewWorkdayRequisitionUploadInput = z.infer<
  typeof previewWorkdayRequisitionUploadInputSchema
>;

// ─────────────── importWorkdayRequisitions ───────────────

export const importWorkdayRequisitionsInputSchema = z.object({
  jobRequisitionIds: z.array(z.string().min(1).max(40)).min(1).max(WORKDAY_UPLOAD_MAX_ROWS),
  /**
   * The same export file the preview was built from. The server re-parses it
   * (it never trusts client-mapped rows). Absent → the built-in demo sample.
   */
  file: workdayUploadFileSchema.optional(),
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
  alreadyImportedCount: z.number().int(),
  skippedCount: z.number().int(),
});
export type ImportWorkdayRequisitionsOutput = z.infer<typeof importWorkdayRequisitionsOutputSchema>;
