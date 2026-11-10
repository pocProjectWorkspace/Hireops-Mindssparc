/**
 * PC-13 — Workday handoff record (file-simulated handoff of the selected
 * candidate back to Workday).
 *
 * Two layers:
 *   - PURE helpers (status derivation, record build, CSV / JSON rendering) —
 *     unit-tested without a database.
 *   - `loadWorkdayHandoffSources` — one RLS-tx read joining the application to
 *     its candidate, requisition/position, latest live offer and its
 *     `hire_employee` workday_sync_outbox row.
 *
 * The outbox payload (built at offer accept in offer-accept.ts) is the source
 * of truth for the fields it snapshots — name, email, phone, title, business
 * unit, location, start date, base pay, currency — so the file matches what
 * was queued for Workday. Fields the payload doesn't carry (candidate id,
 * grade, hiring manager, recruiter, source, Workday JR id) come from live rows.
 * Before acceptance (offer drafted / extended) everything comes from live rows
 * and the record is marked "Offer-ready (pre-approval)".
 *
 * Column keys, headers and order are the PLATFORM DEFAULT
 * WORKDAY_HANDOFF_DEFAULT_COLUMNS (@hireops/api-types); every renderer takes the
 * column list as a parameter so a tenant mapping can replace it later.
 */

import { sql as dsql, type SQL } from "drizzle-orm";
import {
  WORKDAY_HANDOFF_DEFAULT_COLUMNS,
  WORKDAY_HANDOFF_STATUS_LABELS,
  WORKDAY_IMPORT_SOURCE,
  type WorkdayHandoffColumn,
  type WorkdayHandoffRecord,
  type WorkdayHandoffStatus,
} from "@hireops/api-types";

/** The workday_sync_outbox event the handoff is read from (see offer-accept.ts). */
export const WORKDAY_HANDOFF_EVENT_TYPE = "hire_employee";

// ─────────────────────────── pure: status ───────────────────────────

/**
 * Outbox row status wins (it is the handoff); without one, a drafted/extended
 * offer is "offer-ready (pre-approval)". An accepted offer with no outbox row
 * (enqueue is best-effort) reads as `ready` — the record can still be built.
 */
export function deriveWorkdayHandoffStatus(
  outboxStatus: string | null,
  offerStatus: string | null,
): WorkdayHandoffStatus {
  if (outboxStatus) {
    switch (outboxStatus) {
      case "simulated":
        return "sent_simulated";
      case "sent":
        return "sent";
      case "failed":
        return "failed";
      default:
        return "ready"; // pending / processing
    }
  }
  if (offerStatus === "accepted") return "ready";
  if (offerStatus === "drafted" || offerStatus === "extended") return "offer_ready";
  return "none";
}

// ─────────────────────────── pure: record ───────────────────────────

/** The `hire_employee` payload shape written by offer-accept.ts (all optional on read). */
interface HirePayloadView {
  pre_hire?: { full_name?: string | null; email?: string | null; phone?: string | null };
  position?: {
    title?: string | null;
    business_unit_name?: string | null;
    location?: string | null;
  };
  effective_date?: string | null;
  compensation?: { base_annual_inr_paise?: number | null; currency?: string | null };
}

/** One joined source row (see loadWorkdayHandoffSources). */
export interface WorkdayHandoffSource {
  applicationId: string;
  candidateId: string;
  requisitionId: string;
  applicationSource: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  positionTitle: string | null;
  positionLevel: string | null;
  primaryLocation: string | null;
  businessUnitName: string | null;
  bandName: string | null;
  bandLevel: string | null;
  hiringManagerMembershipId: string | null;
  recruiterMembershipId: string | null;
  workdayJobRequisitionId: string | null;
  offerStatus: string | null;
  offerBasePaise: string | null;
  offerJoiningDate: string | null;
  offerLocation: string | null;
  outboxId: string | null;
  outboxStatus: string | null;
  outboxPayload: unknown;
  outboxResponse: unknown;
  outboxCreatedAt: string | null;
  outboxSimulatedAt: string | null;
  outboxClaimedBy: string | null;
}

/** Workday-side reference (WID + descriptor) from a (simulated) response, if any. */
export function workdayReferenceOf(response: unknown): {
  wid: string | null;
  descriptor: string | null;
} {
  const ref = (response as { workday_reference?: { wid?: unknown; descriptor?: unknown } } | null)
    ?.workday_reference;
  return {
    wid: typeof ref?.wid === "string" ? ref.wid : null,
    descriptor: typeof ref?.descriptor === "string" ? ref.descriptor : null,
  };
}

/** Minor units (paise / cents) → a plain decimal amount string, "4200000.00". */
export function formatMinorUnits(
  minor: number | string | bigint | null | undefined,
): string | null {
  if (minor === null || minor === undefined || minor === "") return null;
  const n = typeof minor === "bigint" ? minor : BigInt(String(minor).split(".")[0] ?? "0");
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

/** application_source enum value → "Career Site" (platform-default label). */
export function humanizeSource(source: string | null): string | null {
  if (!source) return null;
  return source
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Build the handoff record. `names` maps membership id → display name.
 * Payload values (the queued snapshot) win over live rows where both exist.
 */
export function buildWorkdayHandoffRecord(
  src: WorkdayHandoffSource,
  names: ReadonlyMap<string, string | null>,
  generatedAt: Date,
): WorkdayHandoffRecord {
  const p = (src.outboxPayload ?? {}) as HirePayloadView;
  const status = deriveWorkdayHandoffStatus(src.outboxStatus, src.offerStatus);
  const ref = workdayReferenceOf(src.outboxResponse);
  const basePaise = p.compensation?.base_annual_inr_paise ?? src.offerBasePaise;
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    candidateId: src.candidateId,
    legalName: str(p.pre_hire?.full_name) ?? str(src.fullName),
    email: str(p.pre_hire?.email) ?? str(src.email),
    phone: str(p.pre_hire?.phone) ?? str(src.phone),
    jobRequisitionId: str(src.workdayJobRequisitionId) ?? src.requisitionId,
    jobTitle: str(p.position?.title) ?? str(src.positionTitle),
    businessUnit: str(p.position?.business_unit_name) ?? str(src.businessUnitName),
    location: str(p.position?.location) ?? str(src.offerLocation) ?? str(src.primaryLocation),
    grade: str(src.bandLevel) ?? str(src.bandName) ?? str(src.positionLevel),
    proposedStartDate: str(p.effective_date) ?? str(src.offerJoiningDate),
    basePay: formatMinorUnits(basePaise),
    // Offers are stored in INR minor units today (offers.base_salary_inr_paise).
    currency:
      basePaise !== null && basePaise !== undefined
        ? (str(p.compensation?.currency) ?? "INR")
        : null,
    hiringManager: nameOf(src.hiringManagerMembershipId),
    recruiter: nameOf(src.recruiterMembershipId),
    source: humanizeSource(src.applicationSource),
    handoffStatus: WORKDAY_HANDOFF_STATUS_LABELS[status],
    workdayReference: ref.wid,
    hireopsApplicationId: src.applicationId,
    hireopsRequisitionId: src.requisitionId,
    generatedAt: generatedAt.toISOString(),
  };
}

// ─────────────────────────── pure: rendering ───────────────────────────

/** RFC-4180 field quoting: wrap in quotes when needed, double embedded quotes. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Records → CSV (header row + one row per record, CRLF, no trailing newline —
 * same shape as the portal's client-side CSV exports). Column order = `columns`.
 */
export function buildWorkdayHandoffCsv(
  records: readonly WorkdayHandoffRecord[],
  columns: readonly WorkdayHandoffColumn[] = WORKDAY_HANDOFF_DEFAULT_COLUMNS,
): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const r of records) {
    lines.push(columns.map((c) => csvField(r[c.key] ?? "")).join(","));
  }
  return lines.join("\r\n");
}

/** Record → header-keyed JSON object, keys in column order. */
export function workdayHandoffJson(
  record: WorkdayHandoffRecord,
  columns: readonly WorkdayHandoffColumn[] = WORKDAY_HANDOFF_DEFAULT_COLUMNS,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const c of columns) out[c.header] = record[c.key] ?? null;
  return out;
}

/** Filesystem-safe filename stem: "workday-handoff-<name>-<app8>". */
export function workdayHandoffFilenameBase(
  legalName: string | null,
  applicationId: string,
): string {
  const slug = (legalName ?? "candidate")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `workday-handoff-${slug || "candidate"}-${applicationId.slice(0, 8)}`;
}

/** Inclusive YYYY-MM-DD → [from 00:00Z, to+1 00:00Z) bounds. */
export function dateRangeBounds(
  from: string | undefined,
  to: string | undefined,
): { fromTs: Date | null; toTsExclusive: Date | null } {
  const fromTs = from ? new Date(`${from}T00:00:00.000Z`) : null;
  let toTsExclusive: Date | null = null;
  if (to) {
    toTsExclusive = new Date(`${to}T00:00:00.000Z`);
    toTsExclusive.setUTCDate(toTsExclusive.getUTCDate() + 1);
  }
  return { fromTs, toTsExclusive };
}

// ─────────────────────────── DB read ───────────────────────────

/** Minimal shape of the RLS-bound drizzle handle (ctx.db). */
interface ExecutesSql {
  execute: (query: SQL) => Promise<unknown>;
}

export type WorkdayHandoffFilter =
  | { kind: "application"; applicationId: string }
  | {
      kind: "bulk";
      requisitionId?: string;
      status: "all" | "pending" | "sent" | "failed";
      fromTs: Date | null;
      toTsExclusive: Date | null;
      limit: number;
    };

interface SourceSqlRow {
  application_id: string;
  candidate_id: string;
  requisition_id: string;
  application_source: string | null;
  full_name: string | null;
  email_primary: string | null;
  phone_primary: string | null;
  position_title: string | null;
  position_level: string | null;
  primary_location: string | null;
  business_unit_name: string | null;
  band_name: string | null;
  band_level: string | null;
  hiring_manager_id: string | null;
  recruiter_membership_id: string | null;
  wd_jr_id: string | null;
  offer_status: string | null;
  offer_base_paise: string | null;
  offer_joining_date: string | null;
  offer_location: string | null;
  outbox_id: string | null;
  outbox_status: string | null;
  outbox_payload: unknown;
  outbox_response: unknown;
  outbox_created_at: Date | string | null;
  outbox_simulated_at: Date | string | null;
  outbox_claimed_by: string | null;
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function jsonValue(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v ?? null;
}

/**
 * One read inside the caller's RLS transaction, with an explicit tenant
 * predicate on every table as well (belt and braces — the same idiom the
 * router uses). Bulk mode returns only applications that HAVE a queued
 * hire_employee row, newest first, capped at `limit` (+1 to detect overflow).
 */
export async function loadWorkdayHandoffSources(
  db: ExecutesSql,
  tenantId: string,
  filter: WorkdayHandoffFilter,
): Promise<WorkdayHandoffSource[]> {
  const where: SQL[] = [dsql`a.tenant_id = ${tenantId}`];
  let orderLimit: SQL;
  if (filter.kind === "application") {
    where.push(dsql`a.id = ${filter.applicationId}`);
    orderLimit = dsql`LIMIT 1`;
  } else {
    where.push(dsql`w.id IS NOT NULL`);
    if (filter.requisitionId) where.push(dsql`a.requisition_id = ${filter.requisitionId}`);
    if (filter.status === "pending") where.push(dsql`w.status IN ('pending', 'processing')`);
    if (filter.status === "sent") where.push(dsql`w.status IN ('simulated', 'sent')`);
    if (filter.status === "failed") where.push(dsql`w.status = 'failed'`);
    if (filter.fromTs)
      where.push(dsql`w.created_at >= ${filter.fromTs.toISOString()}::timestamptz`);
    if (filter.toTsExclusive) {
      where.push(dsql`w.created_at < ${filter.toTsExclusive.toISOString()}::timestamptz`);
    }
    orderLimit = dsql`ORDER BY w.created_at DESC LIMIT ${filter.limit + 1}`;
  }

  const result = await db.execute(dsql`
    SELECT
      a.id::text AS application_id,
      a.candidate_id::text AS candidate_id,
      a.requisition_id::text AS requisition_id,
      a.source::text AS application_source,
      p.full_name,
      p.email_primary,
      p.phone_primary,
      pos.title AS position_title,
      pos.level AS position_level,
      pos.primary_location,
      bu.name AS business_unit_name,
      cb.name AS band_name,
      cb.level AS band_level,
      r.hiring_manager_id::text AS hiring_manager_id,
      COALESCE(a.assigned_recruiter_membership_id, r.primary_recruiter_id)::text
        AS recruiter_membership_id,
      wd.jr_id AS wd_jr_id,
      o.status AS offer_status,
      o.base_salary_inr_paise::text AS offer_base_paise,
      o.joining_date::text AS offer_joining_date,
      o.location AS offer_location,
      w.id::text AS outbox_id,
      w.status AS outbox_status,
      w.payload AS outbox_payload,
      w.simulated_response AS outbox_response,
      w.created_at AS outbox_created_at,
      w.simulated_at AS outbox_simulated_at,
      w.claimed_by AS outbox_claimed_by
    FROM public.applications a
    JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
    JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
    JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
    JOIN public.positions pos ON pos.id = r.position_id AND pos.tenant_id = r.tenant_id
    LEFT JOIN public.business_units bu
      ON bu.id = pos.business_unit_id AND bu.tenant_id = pos.tenant_id
    LEFT JOIN public.comp_bands cb ON cb.id = pos.comp_band_id AND cb.tenant_id = pos.tenant_id
    LEFT JOIN LATERAL (
      SELECT rst.metadata->>'workdayJobRequisitionId' AS jr_id
      FROM public.requisition_state_transitions rst
      WHERE rst.tenant_id = a.tenant_id
        AND rst.requisition_id = a.requisition_id
        AND rst.metadata->>'source' = ${WORKDAY_IMPORT_SOURCE}
      ORDER BY rst.transitioned_at ASC
      LIMIT 1
    ) wd ON true
    LEFT JOIN LATERAL (
      SELECT o2.status, o2.base_salary_inr_paise, o2.joining_date, o2.location
      FROM public.offers o2
      WHERE o2.tenant_id = a.tenant_id
        AND o2.application_id = a.id
        AND o2.status IN ('accepted', 'extended', 'drafted')
      ORDER BY (o2.status = 'accepted') DESC, o2.created_at DESC
      LIMIT 1
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT w2.id, w2.status, w2.payload, w2.simulated_response, w2.created_at,
             w2.simulated_at, w2.claimed_by
      FROM public.workday_sync_outbox w2
      WHERE w2.tenant_id = a.tenant_id
        AND w2.subject_application_id = a.id
        AND w2.event_type = ${WORKDAY_HANDOFF_EVENT_TYPE}
      ORDER BY w2.created_at DESC
      LIMIT 1
    ) w ON true
    WHERE ${dsql.join(where, dsql` AND `)}
    ${orderLimit}
  `);
  const rows = (result as { rows?: SourceSqlRow[] }).rows ?? (result as unknown as SourceSqlRow[]);
  return rows.map((r) => ({
    applicationId: r.application_id,
    candidateId: r.candidate_id,
    requisitionId: r.requisition_id,
    applicationSource: r.application_source,
    fullName: r.full_name,
    email: r.email_primary,
    phone: r.phone_primary,
    positionTitle: r.position_title,
    positionLevel: r.position_level,
    primaryLocation: r.primary_location,
    businessUnitName: r.business_unit_name,
    bandName: r.band_name,
    bandLevel: r.band_level,
    hiringManagerMembershipId: r.hiring_manager_id,
    recruiterMembershipId: r.recruiter_membership_id,
    workdayJobRequisitionId: r.wd_jr_id,
    offerStatus: r.offer_status,
    offerBasePaise: r.offer_base_paise,
    offerJoiningDate: r.offer_joining_date,
    offerLocation: r.offer_location,
    outboxId: r.outbox_id,
    outboxStatus: r.outbox_status,
    outboxPayload: jsonValue(r.outbox_payload),
    outboxResponse: jsonValue(r.outbox_response),
    outboxCreatedAt: iso(r.outbox_created_at),
    outboxSimulatedAt: iso(r.outbox_simulated_at),
    outboxClaimedBy: r.outbox_claimed_by,
  }));
}
