/**
 * "Import from Workday" — export-file parsing + mapping/validation (pure, no DB).
 *
 * HONESTY: there is no live Workday connection. Rows come from a Workday report
 * EXPORT the user uploads (CSV or XLSX, parsed here server-side) or — for demos
 * only — the built-in sample (WORKDAY_SAMPLE_REQUISITIONS in @hireops/api-types).
 * Both become the same normalised WorkdayRequisitionRow. What IS real is the
 * validation: the router loads the tenant's actual business units, member
 * display names and comp bands, and these pure helpers decide per field
 * whether it maps cleanly (✓ mapped) or needs a human's review (⚠
 * needs_review). The tenant lookups are passed in, so this module is
 * unit-testable without a database.
 *
 * XLSX: no spreadsheet library is a direct dependency anywhere in the monorepo,
 * so this module reads the OOXML zip itself (central directory + node:zlib
 * inflate with an output cap — zip-bomb safe) and the first worksheet's XML.
 * Values only: formulas use their cached result; no styles, no macros.
 */

import { inflateRawSync } from "node:zlib";
import {
  WORKDAY_COLUMN_ALIASES,
  WORKDAY_UPLOAD_MAX_BYTES,
  WORKDAY_UPLOAD_MAX_ROWS,
  type WorkdayColumnSpec,
  type WorkdayFieldMapping,
  type WorkdayPreviewRow,
  type WorkdayRequisitionFieldKey,
  type WorkdayRequisitionRow,
  type WorkdayRowError,
  type WorkdaySampleRequisition,
  type WorkdayUploadFile,
} from "@hireops/api-types";

export interface WorkdayBusinessUnitLookup {
  id: string;
  name: string;
}
export interface WorkdayMemberLookup {
  membershipId: string;
  displayName: string | null;
}
export interface WorkdayCompBandLookup {
  id: string;
  name: string;
  level: string | null;
  /** C1-F3 — the band's structured level scope, when set. */
  jobLevelId?: string | null;
}
/** C1-F3 — a tenant job level (grade); the Workday grade maps onto `key`. */
export interface WorkdayJobLevelLookup {
  id: string;
  key: string;
  label: string;
}

export interface WorkdayTenantLookups {
  businessUnits: WorkdayBusinessUnitLookup[];
  members: WorkdayMemberLookup[];
  compBands: WorkdayCompBandLookup[];
  /** C1-F3 — active job levels. Optional: absent = no level mapping. */
  jobLevels?: WorkdayJobLevelLookup[];
}

/** Lower-case, strip punctuation/dashes, collapse whitespace. */
export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Comp grade → band. Exact (case-insensitive) match on comp_bands.level first,
 * then a whole-token match of the grade inside the band name (e.g. "IN09" in
 * "Acme IN09 — Assistant / Analyst"). No fuzzy guessing beyond that.
 */
export function matchCompBand<T extends WorkdayCompBandLookup>(
  grade: string,
  bands: T[],
): T | null {
  const g = normaliseName(grade);
  if (!g) return null;
  const byLevel = bands.find((b) => b.level && normaliseName(b.level) === g);
  if (byLevel) return byLevel;
  return bands.find((b) => normaliseName(b.name).split(" ").includes(g)) ?? null;
}

/**
 * C1-F3 — Workday Compensation Grade → tenant job level, by KEY only (exact,
 * case/punctuation-insensitive: "IN-12" = "in12" = "IN12"). The key is the
 * stable grade code; no label or fuzzy matching — a grade either is a level
 * the tenant defined or it is flagged for review.
 */
export function matchJobLevel<T extends WorkdayJobLevelLookup>(
  grade: string,
  levels: T[],
): T | null {
  const g = normaliseName(grade).replace(/ /g, "");
  if (!g) return null;
  return levels.find((l) => normaliseName(l.key).replace(/ /g, "") === g) ?? null;
}

/**
 * Person name → member. Exact normalised display-name match only — a hiring
 * manager is an accountable person, so a partial match is NOT treated as found.
 */
export function matchMemberByName<T extends WorkdayMemberLookup>(
  name: string,
  members: T[],
): T | null {
  const n = normaliseName(name);
  if (!n) return null;
  return members.find((m) => m.displayName && normaliseName(m.displayName) === n) ?? null;
}

/**
 * Supervisory Organization → business unit. Exact normalised name match is a
 * clean ✓. Otherwise falls back (flagged ⚠) to a unit whose name shares the
 * org's leading segment (e.g. "GBS India" from "GBS India — Order to Cash"),
 * else the tenant's first unit. `exact` tells the caller which happened.
 */
export function matchBusinessUnit<T extends WorkdayBusinessUnitLookup>(
  org: string,
  units: T[],
): { unit: T | null; exact: boolean } {
  const n = normaliseName(org);
  const exact = n ? units.find((u) => normaliseName(u.name) === n) : undefined;
  if (exact) return { unit: exact, exact: true };
  const lead = normaliseName(org.split(/[—–-]/)[0] ?? "");
  const partial = lead ? units.find((u) => normaliseName(u.name).startsWith(lead)) : undefined;
  return { unit: partial ?? units[0] ?? null, exact: false };
}

/** ISO yyyy-mm-dd for `today + offsetDays` (UTC). */
export function targetHireDateIso(offsetDays: number, today: Date = new Date()): string {
  const d = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offsetDays),
  );
  return d.toISOString().slice(0, 10);
}

/** "Hyderabad, India" → "Hyderabad" for positions.primary_location. */
export function locationToPrimaryLocation(location: string): string {
  return (location.split(",")[0] ?? location).trim();
}

// ═════════════════════ Value parsing (numbers, dates) ═════════════════════

/** Number of Openings → integer 1..999. Blank → 1 (ok); unreadable → 1 (flagged). */
export function parseOpenings(raw: string): { value: number; ok: boolean; blank: boolean } {
  const t = raw.trim();
  if (!t) return { value: 1, ok: true, blank: true };
  const n = Number(t.replace(/,/g, ""));
  if (Number.isInteger(n) && n >= 1 && n <= 999) return { value: n, ok: true, blank: false };
  return { value: 1, ok: false, blank: false };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function monthNumber(word: string): number | undefined {
  return MONTHS[word.toLowerCase().slice(0, 3)];
}

function isoFromParts(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

/** Excel serial day number (1900 date system) → ISO date. */
export function excelSerialToIso(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export type ParsedWorkdayDate =
  | { iso: string; ambiguous: boolean }
  | { iso: null; ambiguous: false };

/**
 * A Workday export date → ISO yyyy-mm-dd. Accepts ISO (optionally with a
 * time), "15-Nov-2026" / "15 Nov 2026" / "Nov 15, 2026", slash/dot/dash
 * numeric dates, and Excel serial numbers (XLSX date cells). A numeric
 * d/m/y where both parts are ≤ 12 is AMBIGUOUS: read as month/day (Workday's
 * US export default) and reported so the mapper can flag it for review.
 */
export function parseWorkdayDate(raw: string): ParsedWorkdayDate {
  const none = { iso: null, ambiguous: false } as const;
  const t = raw.trim();
  if (!t) return none;
  const ok = (iso: string | null, ambiguous = false): ParsedWorkdayDate =>
    iso ? { iso, ambiguous } : none;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return ok(isoFromParts(Number(m[1]), Number(m[2]), Number(m[3])));

  if (/^\d{5}(?:\.\d+)?$/.test(t)) {
    const serial = Number(t);
    return serial >= 20_000 && serial <= 120_000 ? ok(excelSerialToIso(serial)) : none;
  }

  m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{4})$/.exec(t);
  if (m) {
    const mon = monthNumber(m[2] ?? "");
    return ok(mon ? isoFromParts(Number(m[3]), mon, Number(m[1])) : null);
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (m) {
    const mon = monthNumber(m[1] ?? "");
    return ok(mon ? isoFromParts(Number(m[3]), mon, Number(m[2])) : null);
  }

  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (a > 12) return ok(isoFromParts(y, b, a));
    return ok(isoFromParts(y, a, b), b <= 12 && a !== b);
  }
  return none;
}

// ═════════════════════ Row → mapping ═════════════════════

/** The resolved create-time values for one row. */
export interface WorkdayResolvedRow {
  title: string;
  businessUnitId: string | null;
  hiringManagerMembershipId: string | null;
  compBandId: string | null;
  /** C1-F3 — the tenant job level the grade mapped to (by key), else null. */
  jobLevelId: string | null;
  primaryLocation: string | null;
  numberOfOpenings: number;
  targetStartDate: string | null;
}

/**
 * Build the per-field mapping for one row against the tenant lookups. Returns
 * the display mapping AND the values the import will actually write, so the
 * preview and the import can never disagree.
 */
export function mapWorkdayRow(
  row: WorkdayRequisitionRow,
  lookups: WorkdayTenantLookups,
  callerName: string | null,
): { mapping: WorkdayFieldMapping[]; resolved: WorkdayResolvedRow } {
  const mapping: WorkdayFieldMapping[] = [];
  const push = (m: WorkdayFieldMapping) => mapping.push(m);
  const title = row.jobPostingTitle.trim();

  push({
    workdayField: "Job Posting Title",
    workdayValue: title,
    hireopsField: "Position title",
    hireopsValue: title,
    status: "mapped",
    note: null,
  });

  const org = row.supervisoryOrganization.trim();
  const bu = matchBusinessUnit(org, lookups.businessUnits);
  push({
    workdayField: "Supervisory Organization",
    workdayValue: org,
    hireopsField: "Business unit",
    hireopsValue: bu.unit?.name ?? null,
    status: bu.exact ? "mapped" : "needs_review",
    note: bu.exact
      ? null
      : !bu.unit
        ? "No business units configured — add one in Admin → Business units"
        : org
          ? `No business unit named "${org}" — will use "${bu.unit.name}"`
          : `No Supervisory Organization in the export — will use "${bu.unit.name}"`,
  });

  const location = row.location.trim();
  const primaryLocation = location ? locationToPrimaryLocation(location) : null;
  push({
    workdayField: "Location",
    workdayValue: location,
    hireopsField: "Primary location",
    hireopsValue: primaryLocation,
    status: primaryLocation ? "mapped" : "not_imported",
    note: primaryLocation ? null : "Not in the export — left blank",
  });

  const rawOpenings = row.numberOfOpenings.trim();
  const openings = parseOpenings(rawOpenings);
  push({
    workdayField: "Number of Openings",
    workdayValue: rawOpenings,
    hireopsField: "Number of openings",
    hireopsValue: String(openings.value),
    status: openings.ok ? "mapped" : "needs_review",
    note: !openings.ok
      ? `"${rawOpenings}" is not a whole number from 1 to 999 — will use 1`
      : openings.blank
        ? "Not in the export — defaults to 1"
        : null,
  });

  const rawDate = row.targetHireDate.trim();
  const date = parseWorkdayDate(rawDate);
  let dateStatus: WorkdayFieldMapping["status"];
  let dateNote: string | null;
  if (date.iso) {
    dateStatus = date.ambiguous ? "needs_review" : "mapped";
    dateNote = date.ambiguous
      ? `"${rawDate}" could be day/month or month/day — read as ${date.iso} (month/day)`
      : null;
  } else if (rawDate) {
    dateStatus = "needs_review";
    dateNote = `"${rawDate}" is not a recognisable date — target start date left blank`;
  } else {
    dateStatus = "not_imported";
    dateNote = "Not in the export — left blank";
  }
  push({
    workdayField: "Target Hire Date",
    workdayValue: rawDate,
    hireopsField: "Target start date",
    hireopsValue: date.iso,
    status: dateStatus,
    note: dateNote,
  });

  const hmName = row.hiringManager.trim();
  const hm = matchMemberByName(hmName, lookups.members);
  push({
    workdayField: "Hiring Manager",
    workdayValue: hmName,
    hireopsField: "Hiring manager",
    hireopsValue: hm ? (hm.displayName ?? null) : callerName,
    status: hm ? "mapped" : "needs_review",
    note: hm
      ? null
      : hmName
        ? `"${hmName}" is not a HireOps user — you will be set as hiring manager until reassigned`
        : "No hiring manager in the export — you will be set as hiring manager until reassigned",
  });

  const grade = row.compensationGrade.trim();
  // C1-F3 — grade → job level by key (when the tenant has defined levels).
  // A band pinned to that level wins over the free-text level/name match.
  const levels = lookups.jobLevels ?? [];
  const jobLevel = levels.length > 0 ? matchJobLevel(grade, levels) : null;
  const band =
    (jobLevel ? lookups.compBands.find((b) => b.jobLevelId === jobLevel.id) : undefined) ??
    matchCompBand(grade, lookups.compBands);
  if (levels.length > 0) {
    push({
      workdayField: "Compensation Grade",
      workdayValue: grade,
      hireopsField: "Job level",
      hireopsValue: jobLevel ? `${jobLevel.label} (${jobLevel.key})` : null,
      status: jobLevel ? "mapped" : grade ? "needs_review" : "not_imported",
      note: jobLevel
        ? null
        : grade
          ? `No job level with key ${grade} — add it in Admin → Job architecture, or pick the level on the draft`
          : "No grade in the export — level left blank",
    });
  }
  push({
    workdayField: "Compensation Grade",
    workdayValue: grade,
    hireopsField: "Comp band",
    hireopsValue: band?.name ?? null,
    status: band ? "mapped" : "needs_review",
    note: band
      ? null
      : grade
        ? `No comp band for grade ${grade} — budget left blank for review`
        : "No grade in the export — budget left blank for review",
  });

  push({
    workdayField: "Job description + skills",
    workdayValue: `${row.jobDescription.length} lines · ${row.skills.length} skills`,
    hireopsField: "Draft JD + skills",
    hireopsValue: row.skills.length ? row.skills.join(", ") : null,
    status: "mapped",
    note:
      row.jobDescription.length === 0 && row.skills.length === 0
        ? "No description or skills in the export — write the JD in the draft"
        : null,
  });

  const notImported: { field: string; value: string; note: string | null }[] = [
    { field: "Job Profile", value: row.jobProfile, note: null },
    { field: "Worker Type", value: row.workerType, note: null },
    { field: "Time Type", value: row.timeType, note: null },
    {
      field: "Recruiter",
      value: row.recruiter,
      note: "Recruiter is assigned in HireOps after import",
    },
    { field: "Reason", value: row.reason, note: null },
  ];
  for (const f of notImported) {
    push({
      workdayField: f.field,
      workdayValue: f.value.trim(),
      hireopsField: "—",
      hireopsValue: null,
      status: "not_imported",
      note: f.note,
    });
  }

  return {
    mapping,
    resolved: {
      title,
      businessUnitId: bu.unit?.id ?? null,
      hiringManagerMembershipId: hm?.membershipId ?? null,
      compBandId: band?.id ?? null,
      jobLevelId: jobLevel?.id ?? null,
      primaryLocation,
      numberOfOpenings: openings.value,
      targetStartDate: date.iso,
    },
  };
}

/** Workday display fields (keyed by WORKDAY_PREVIEW_COLUMNS) for the preview table. */
export function workdayDisplayFields(row: WorkdayRequisitionRow): Record<string, string> {
  return {
    "Job Requisition ID": row.jobRequisitionId,
    "Job Posting Title": row.jobPostingTitle,
    "Job Profile": row.jobProfile,
    "Supervisory Organization": row.supervisoryOrganization,
    Location: row.location,
    "Worker Type": row.workerType,
    "Time Type": row.timeType,
    "Number of Openings": row.numberOfOpenings,
    "Target Hire Date": parseWorkdayDate(row.targetHireDate).iso ?? row.targetHireDate,
    "Hiring Manager": row.hiringManager,
    Recruiter: row.recruiter,
    "Compensation Grade": row.compensationGrade,
    Reason: row.reason,
  };
}

/** Build a full preview row (mapping + display + already-imported flag). */
export function buildWorkdayPreviewRow(
  row: WorkdayRequisitionRow,
  lookups: WorkdayTenantLookups,
  callerName: string | null,
  alreadyImportedRequisitionId: string | null,
): WorkdayPreviewRow {
  const { mapping } = mapWorkdayRow(row, lookups, callerName);
  return {
    rowNumber: row.rowNumber,
    jobRequisitionId: row.jobRequisitionId,
    fields: workdayDisplayFields(row),
    jobDescription: [...row.jobDescription],
    skills: [...row.skills],
    mapping,
    needsReviewCount: mapping.filter((m) => m.status === "needs_review").length,
    alreadyImported: alreadyImportedRequisitionId
      ? { requisitionId: alreadyImportedRequisitionId }
      : null,
  };
}

/**
 * The draft JD sections seeded from the Workday description + skills — the same
 * {summary, responsibilities, requirements} shape the wizard's JD editor stores
 * in jd_versions.ai_metadata.sections (rendered to jd_text via composeJdText).
 * `sourceLabel` names where the row came from (e.g. `the Workday export
 * "reqs.csv"`).
 */
export function workdayJdSections(
  row: WorkdayRequisitionRow,
  sourceLabel: string,
): {
  summary: string;
  responsibilities: string[];
  requirements: string[];
} {
  const title = row.jobPostingTitle.trim();
  const profile = row.jobProfile.trim();
  const where = [row.supervisoryOrganization.trim(), row.location.trim()]
    .filter(Boolean)
    .join(", ");
  const head = `${title}${profile ? ` (${profile})` : ""}${where ? ` in ${where}` : ""}.`;
  return {
    summary: `${head} Imported from ${sourceLabel}, Workday requisition ${row.jobRequisitionId} — review and edit before submitting.`,
    responsibilities: [...row.jobDescription],
    requirements: row.skills.map((s) => `Hands-on experience with ${s}`),
  };
}

/** The built-in demo sample as normalised rows (target date resolved from today). */
export function workdaySampleRows(
  sample: readonly WorkdaySampleRequisition[],
  today: Date = new Date(),
): WorkdayRequisitionRow[] {
  return sample.map((s, i) => ({
    rowNumber: i + 1,
    jobRequisitionId: s["Job Requisition ID"],
    jobPostingTitle: s["Job Posting Title"],
    jobProfile: s["Job Profile"],
    supervisoryOrganization: s["Supervisory Organization"],
    location: s.Location,
    workerType: s["Worker Type"],
    timeType: s["Time Type"],
    numberOfOpenings: String(s["Number of Openings"]),
    targetHireDate: targetHireDateIso(s.targetHireDateOffsetDays, today),
    hiringManager: s["Hiring Manager"],
    recruiter: s.Recruiter,
    compensationGrade: s["Compensation Grade"],
    reason: s.Reason,
    jobDescription: [...s.jobDescription],
    skills: [...s.skills],
  }));
}

// ═════════════════════ Export-file parsing ═════════════════════

/** A user-facing problem with the uploaded file (router → BAD_REQUEST). */
export class WorkdayImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkdayImportFileError";
  }
}

export interface ParsedWorkdayExport {
  rows: WorkdayRequisitionRow[];
  /** Headers present in the file that are not imported. */
  unmappedColumns: string[];
  rowErrors: WorkdayRowError[];
}

const MAX_ID_CHARS = 40;
const MAX_TITLE_CHARS = 200;
const MAX_SKILLS = 50;
const MAX_SKILL_CHARS = 120;
const MAX_JD_LINES = 40;
const MAX_JD_LINE_CHARS = 2000;
/** Header row is searched for in the first N rows (reports can have title rows). */
const HEADER_SEARCH_ROWS = 10;
/** Cap on any single decompressed XLSX part (zip-bomb guard). */
const MAX_XLSX_PART_BYTES = 64 * 1024 * 1024;

const pretty = (n: number) => n.toLocaleString("en-US");

/** Pick , ; or TAB — whichever appears most in the first line (outside quotes). */
function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  let best = ",";
  for (const d of [";", "\t"]) if ((counts[d] ?? 0) > (counts[best] ?? 0)) best = d;
  return best;
}

/** RFC 4180 CSV → rows of cells. Quoted fields, "" escapes, CR/LF/CRLF, embedded newlines, BOM. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Bytes → text: UTF-16 (with BOM) or UTF-8 (BOM stripped). */
export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─────────────── Minimal XLSX (OOXML) reader ───────────────

function notXlsxError(): WorkdayImportFileError {
  return new WorkdayImportFileError(
    "This file is not a valid .xlsx workbook. Re-export it from Workday as Excel (.xlsx) or CSV.",
  );
}

/** Read the wanted entries of a (non-ZIP64, unencrypted) zip into name → bytes. */
function readZipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notXlsxError();
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw notXlsxError();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    if (flags & 0x1) {
      throw new WorkdayImportFileError(
        "This workbook is password-protected. Remove the password or export as CSV.",
      );
    }
    if (compSize === 0xffffffff || localOffset === 0xffffffff) throw notXlsxError();
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw notXlsxError();
    }
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      out.set(name, Buffer.from(data));
    } else if (method === 8) {
      try {
        out.set(name, inflateRawSync(data, { maxOutputLength: MAX_XLSX_PART_BYTES }));
      } catch {
        throw new WorkdayImportFileError(
          "This workbook could not be read (it is corrupt or expands too large). Export it as CSV instead.",
        );
      }
    } else {
      throw notXlsxError();
    }
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, ent: string) => {
      if (ent.startsWith("#x")) return String.fromCodePoint(parseInt(ent.slice(2), 16));
      if (ent.startsWith("#")) return String.fromCodePoint(parseInt(ent.slice(1), 10));
      return XML_ENTITIES[ent] ?? whole;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Concatenated text of every <t> run in an <si>/<is> fragment (phonetic runs dropped). */
function richText(fragment: string): string {
  const body = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1] ?? "";
  return decodeXml(out);
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** First worksheet of an .xlsx → rows of cell text (values only). */
export function readXlsxRows(buf: Buffer): string[][] {
  const parts = readZipEntries(
    buf,
    (n) =>
      n === "xl/workbook.xml" ||
      n === "xl/_rels/workbook.xml.rels" ||
      n === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(n),
  );
  // Element names may carry a namespace prefix (`<x:row>` from some writers) —
  // drop it so the patterns below see plain OOXML element names.
  const text = (n: string) =>
    parts
      .get(n)
      ?.toString("utf8")
      .replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, "<$1");

  // Resolve the FIRST sheet in workbook order via its relationship id.
  let sheetPath: string | undefined;
  const workbook = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const firstSheet = workbook ? /<sheet\b[^>]*>/.exec(workbook)?.[0] : undefined;
  const rid = firstSheet ? /\br:id="([^"]+)"/.exec(firstSheet)?.[1] : undefined;
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (/\bId="([^"]+)"/.exec(tag)?.[1] !== rid) continue;
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    }
  }
  if (!sheetPath || !parts.has(sheetPath)) {
    sheetPath = parts.has("xl/worksheets/sheet1.xml")
      ? "xl/worksheets/sheet1.xml"
      : [...parts.keys()].filter((k) => k.startsWith("xl/worksheets/")).sort()[0];
  }
  const sheet = sheetPath ? text(sheetPath) : undefined;
  if (!sheet) {
    throw new WorkdayImportFileError("This workbook has no worksheet to read.");
  }

  const shared: string[] = [];
  const sst = text("xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(richText(m[1] ?? ""));
  }

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = /\br="(\d+)"/.exec(rm[1] ?? "")?.[1];
    const rowIdx = rAttr ? Number(rAttr) - 1 : rows.length;
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? "";
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: string;
      if (type === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
      else if (type === "inlineStr") {
        value = richText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
      } else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else value = v !== undefined ? decodeXml(v) : "";
      cells[col] = value;
    }
    rows[rowIdx] = Array.from(cells, (c) => c ?? "");
  }
  return Array.from(rows, (r) => r ?? []);
}

// ─────────────── Header mapping + row extraction ───────────────

const ALIAS_INDEX: Map<string, { spec: WorkdayColumnSpec; rank: number }> = (() => {
  const m = new Map<string, { spec: WorkdayColumnSpec; rank: number }>();
  for (const spec of WORKDAY_COLUMN_ALIASES) {
    [spec.label, ...spec.aliases].forEach((alias, rank) => {
      const key = normaliseName(alias);
      if (!m.has(key)) m.set(key, { spec, rank });
    });
  }
  return m;
})();

/** Which canonical field a header names, if any. */
export function matchWorkdayHeader(header: string): WorkdayRequisitionFieldKey | null {
  return ALIAS_INDEX.get(normaliseName(header))?.spec.key ?? null;
}

function missingColumnsError(missing: WorkdayColumnSpec[]): WorkdayImportFileError {
  const detail = missing
    .map(
      (s) => `"${s.label}" (also accepted: ${s.aliases.filter((a) => a !== s.label).join(", ")})`,
    )
    .join("; ");
  return new WorkdayImportFileError(
    `Missing required column${missing.length === 1 ? "" : "s"}: ${missing
      .map((s) => s.label)
      .join(", ")}. Expected ${detail}.`,
  );
}

const BULLET_PREFIX = /^[\s•\-*·]+/;

/** Split a multi-value cell (skills): newlines, semicolons, pipes — else commas. */
function splitList(cell: string): string[] {
  const t = cell.trim();
  if (!t) return [];
  const parts = /[\n;|]/.test(t) ? t.split(/[\n;|]+/) : t.split(",");
  return parts.map((p) => p.replace(BULLET_PREFIX, "").trim()).filter(Boolean);
}

/** Job description cell → lines (one per paragraph/bullet). */
function splitLines(cell: string): string[] {
  return cell
    .split(/\r?\n+/)
    .map((p) => p.replace(BULLET_PREFIX, "").trim())
    .filter(Boolean)
    .slice(0, MAX_JD_LINES)
    .map((l) => l.slice(0, MAX_JD_LINE_CHARS));
}

/** Trim, cap length, drop case-insensitive duplicates (jd_skills is unique per name). */
function dedupeSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of skills) {
    const v = s.slice(0, MAX_SKILL_CHARS).trim();
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}

/**
 * A table of cells (CSV or sheet) → normalised rows. Finds the header row in
 * the first HEADER_SEARCH_ROWS rows, maps headers through
 * WORKDAY_COLUMN_ALIASES, rejects a file missing a required column, skips
 * blank rows, enforces WORKDAY_UPLOAD_MAX_ROWS, and reports unimportable rows
 * (missing id/title, over-long values, duplicate ids) as rowErrors.
 */
export function workdayRowsFromTable(table: string[][]): ParsedWorkdayExport {
  const isBlank = (r: string[] | undefined) => !r || r.every((c) => !c || !c.trim());
  const required = WORKDAY_COLUMN_ALIASES.filter((s) => s.required);

  let headerIdx = -1;
  for (let i = 0; i < Math.min(table.length, HEADER_SEARCH_ROWS); i++) {
    const r = table[i];
    if (!r || isBlank(r)) continue;
    if (r.some((h) => required.some((s) => matchWorkdayHeader(h ?? "") === s.key))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    if (table.every((r) => isBlank(r))) {
      throw new WorkdayImportFileError("The file is empty — no header row or requisition rows.");
    }
    throw missingColumnsError(required);
  }

  const header = (table[headerIdx] ?? []).map((h) => (h ?? "").trim());
  // Best header per field = the one matching its earliest alias.
  const chosen = new Map<WorkdayRequisitionFieldKey, { col: number; rank: number }>();
  header.forEach((h, col) => {
    const hit = ALIAS_INDEX.get(normaliseName(h));
    if (!hit) return;
    const prev = chosen.get(hit.spec.key);
    if (!prev || hit.rank < prev.rank) chosen.set(hit.spec.key, { col, rank: hit.rank });
  });
  const usedCols = new Set([...chosen.values()].map((c) => c.col));
  const unmappedColumns = header.filter((h, col) => h && !usedCols.has(col));

  const missing = required.filter((s) => !chosen.has(s.key));
  if (missing.length) throw missingColumnsError(missing);

  const cell = (r: string[], key: WorkdayRequisitionFieldKey) => {
    const c = chosen.get(key);
    return c ? (r[c.col] ?? "").trim() : "";
  };

  const dataRows: { rowNumber: number; cells: string[] }[] = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (!r || isBlank(r)) continue;
    dataRows.push({ rowNumber: i + 1, cells: r });
  }
  if (dataRows.length > WORKDAY_UPLOAD_MAX_ROWS) {
    throw new WorkdayImportFileError(
      `The file has ${pretty(dataRows.length)} requisition rows; the limit is ${pretty(
        WORKDAY_UPLOAD_MAX_ROWS,
      )} per upload. Split the export into smaller files.`,
    );
  }

  const rows: WorkdayRequisitionRow[] = [];
  const rowErrors: WorkdayRowError[] = [];
  const firstRowById = new Map<string, number>();
  for (const { rowNumber, cells } of dataRows) {
    const id = cell(cells, "jobRequisitionId");
    const title = cell(cells, "jobPostingTitle");
    const fail = (message: string) =>
      rowErrors.push({ rowNumber, jobRequisitionId: id || null, message });
    if (!id) {
      fail("No Job Requisition ID — row not imported");
      continue;
    }
    if (id.length > MAX_ID_CHARS) {
      fail(`Job Requisition ID is longer than ${MAX_ID_CHARS} characters — row not imported`);
      continue;
    }
    if (title.length < 2) {
      fail("No Job Posting Title — row not imported");
      continue;
    }
    if (title.length > MAX_TITLE_CHARS) {
      fail(`Job Posting Title is longer than ${MAX_TITLE_CHARS} characters — row not imported`);
      continue;
    }
    const firstRow = firstRowById.get(id);
    if (firstRow !== undefined) {
      fail(`Duplicate of row ${firstRow} (same Job Requisition ID) — row not imported`);
      continue;
    }
    firstRowById.set(id, rowNumber);
    rows.push({
      rowNumber,
      jobRequisitionId: id,
      jobPostingTitle: title,
      jobProfile: cell(cells, "jobProfile"),
      supervisoryOrganization: cell(cells, "supervisoryOrganization"),
      location: cell(cells, "location"),
      workerType: cell(cells, "workerType"),
      timeType: cell(cells, "timeType"),
      numberOfOpenings: cell(cells, "numberOfOpenings"),
      targetHireDate: cell(cells, "targetHireDate"),
      hiringManager: cell(cells, "hiringManager"),
      recruiter: cell(cells, "recruiter"),
      compensationGrade: cell(cells, "compensationGrade"),
      reason: cell(cells, "reason"),
      jobDescription: splitLines(cell(cells, "jobDescription")),
      skills: dedupeSkills(splitList(cell(cells, "skills"))),
    });
  }
  if (rows.length === 0 && rowErrors.length === 0) {
    throw new WorkdayImportFileError("The file has a header row but no requisition rows.");
  }
  return { rows, unmappedColumns, rowErrors };
}

/**
 * Decode + parse an uploaded Workday export. Throws WorkdayImportFileError for
 * anything the user must fix (type, size, structure, missing columns, rows).
 */
export function parseWorkdayExportFile(file: WorkdayUploadFile): ParsedWorkdayExport {
  const ext = /\.([a-z0-9]+)$/i.exec(file.fileName.trim())?.[1]?.toLowerCase();
  if (ext === "xls") {
    throw new WorkdayImportFileError(
      "Legacy .xls workbooks aren't supported — save the export as .xlsx or CSV.",
    );
  }
  if (ext !== "csv" && ext !== "xlsx") {
    throw new WorkdayImportFileError("Upload a Workday export as a .csv or .xlsx file.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64)) {
    throw new WorkdayImportFileError("The file content could not be read (invalid encoding).");
  }
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.length > WORKDAY_UPLOAD_MAX_BYTES) {
    throw new WorkdayImportFileError(
      `The file is larger than ${WORKDAY_UPLOAD_MAX_BYTES / (1024 * 1024)} MB. Split the export into smaller files.`,
    );
  }
  if (bytes.length === 0) {
    throw new WorkdayImportFileError("The file is empty — no header row or requisition rows.");
  }
  const table = ext === "xlsx" ? readXlsxRows(bytes) : parseCsv(decodeText(bytes));
  return workdayRowsFromTable(table);
}
