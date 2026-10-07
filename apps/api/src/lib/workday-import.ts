/**
 * "Import from Workday" — PoC PREVIEW mapping + validation (pure, no DB).
 *
 * HONESTY: there is no live Workday connection. The rows come from the built-in
 * sample Workday export (WORKDAY_SAMPLE_REQUISITIONS in @hireops/api-types).
 * What IS real is the validation: the router loads the tenant's actual business
 * units, member display names and comp bands, and these pure helpers decide
 * per field whether it maps cleanly (✓ mapped) or needs a human's review
 * (⚠ needs_review). The tenant lookups are passed in, so this module is
 * unit-testable without a database.
 */

import type {
  WorkdayFieldMapping,
  WorkdayPreviewRow,
  WorkdaySampleRequisition,
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
}

export interface WorkdayTenantLookups {
  businessUnits: WorkdayBusinessUnitLookup[];
  members: WorkdayMemberLookup[];
  compBands: WorkdayCompBandLookup[];
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
 * "Solenis IN09 — Assistant / Analyst"). No fuzzy guessing beyond that.
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
  const exact = units.find((u) => normaliseName(u.name) === n);
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

/** The resolved create-time values for one sample row. */
export interface WorkdayResolvedRow {
  businessUnitId: string | null;
  hiringManagerMembershipId: string | null;
  compBandId: string | null;
  primaryLocation: string;
  targetStartDate: string;
}

/**
 * Build the per-field mapping for one sample row against the tenant lookups.
 * Returns the display mapping AND the values the import will actually write,
 * so the preview and the import can never disagree.
 */
export function mapWorkdayRow(
  row: WorkdaySampleRequisition,
  lookups: WorkdayTenantLookups,
  callerName: string | null,
  today: Date = new Date(),
): { mapping: WorkdayFieldMapping[]; resolved: WorkdayResolvedRow } {
  const mapping: WorkdayFieldMapping[] = [];
  const push = (m: WorkdayFieldMapping) => mapping.push(m);

  push({
    workdayField: "Job Posting Title",
    workdayValue: row["Job Posting Title"],
    hireopsField: "Position title",
    hireopsValue: row["Job Posting Title"],
    status: "mapped",
    note: null,
  });

  const bu = matchBusinessUnit(row["Supervisory Organization"], lookups.businessUnits);
  push({
    workdayField: "Supervisory Organization",
    workdayValue: row["Supervisory Organization"],
    hireopsField: "Business unit",
    hireopsValue: bu.unit?.name ?? null,
    status: bu.exact ? "mapped" : "needs_review",
    note: bu.exact
      ? null
      : bu.unit
        ? `No business unit named "${row["Supervisory Organization"]}" — will use "${bu.unit.name}"`
        : "No business units configured — add one in Admin → Business units",
  });

  const primaryLocation = locationToPrimaryLocation(row.Location);
  push({
    workdayField: "Location",
    workdayValue: row.Location,
    hireopsField: "Primary location",
    hireopsValue: primaryLocation,
    status: "mapped",
    note: null,
  });

  push({
    workdayField: "Number of Openings",
    workdayValue: String(row["Number of Openings"]),
    hireopsField: "Number of openings",
    hireopsValue: String(row["Number of Openings"]),
    status: "mapped",
    note: null,
  });

  const targetStartDate = targetHireDateIso(row.targetHireDateOffsetDays, today);
  push({
    workdayField: "Target Hire Date",
    workdayValue: targetStartDate,
    hireopsField: "Target start date",
    hireopsValue: targetStartDate,
    status: "mapped",
    note: null,
  });

  const hm = matchMemberByName(row["Hiring Manager"], lookups.members);
  push({
    workdayField: "Hiring Manager",
    workdayValue: row["Hiring Manager"],
    hireopsField: "Hiring manager",
    hireopsValue: hm ? (hm.displayName ?? null) : callerName,
    status: hm ? "mapped" : "needs_review",
    note: hm
      ? null
      : `"${row["Hiring Manager"]}" is not a HireOps user — you will be set as hiring manager until reassigned`,
  });

  const band = matchCompBand(row["Compensation Grade"], lookups.compBands);
  push({
    workdayField: "Compensation Grade",
    workdayValue: row["Compensation Grade"],
    hireopsField: "Comp band",
    hireopsValue: band?.name ?? null,
    status: band ? "mapped" : "needs_review",
    note: band
      ? null
      : `No comp band for grade ${row["Compensation Grade"]} — budget left blank for review`,
  });

  push({
    workdayField: "Job description + skills",
    workdayValue: `${row.jobDescription.length} lines · ${row.skills.length} skills`,
    hireopsField: "Draft JD + skills",
    hireopsValue: row.skills.join(", "),
    status: "mapped",
    note: null,
  });

  for (const field of ["Job Profile", "Worker Type", "Time Type", "Recruiter", "Reason"] as const) {
    push({
      workdayField: field,
      workdayValue: String(row[field]),
      hireopsField: "—",
      hireopsValue: null,
      status: "not_imported",
      note: field === "Recruiter" ? "Recruiter is assigned in HireOps after import" : null,
    });
  }

  return {
    mapping,
    resolved: {
      businessUnitId: bu.unit?.id ?? null,
      hiringManagerMembershipId: hm?.membershipId ?? null,
      compBandId: band?.id ?? null,
      primaryLocation,
      targetStartDate,
    },
  };
}

/** Workday display fields (incl. resolved Target Hire Date) for the preview table. */
export function workdayDisplayFields(
  row: WorkdaySampleRequisition,
  today: Date = new Date(),
): Record<string, string> {
  return {
    "Job Requisition ID": row["Job Requisition ID"],
    "Job Posting Title": row["Job Posting Title"],
    "Job Profile": row["Job Profile"],
    "Supervisory Organization": row["Supervisory Organization"],
    Location: row.Location,
    "Worker Type": row["Worker Type"],
    "Time Type": row["Time Type"],
    "Number of Openings": String(row["Number of Openings"]),
    "Target Hire Date": targetHireDateIso(row.targetHireDateOffsetDays, today),
    "Hiring Manager": row["Hiring Manager"],
    Recruiter: row.Recruiter,
    "Compensation Grade": row["Compensation Grade"],
    Reason: row.Reason,
  };
}

/** Build a full preview row (mapping + display + already-imported flag). */
export function buildWorkdayPreviewRow(
  row: WorkdaySampleRequisition,
  lookups: WorkdayTenantLookups,
  callerName: string | null,
  alreadyImportedRequisitionId: string | null,
  today: Date = new Date(),
): WorkdayPreviewRow {
  const { mapping } = mapWorkdayRow(row, lookups, callerName, today);
  return {
    jobRequisitionId: row["Job Requisition ID"],
    fields: workdayDisplayFields(row, today),
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
 */
export function workdayJdSections(row: WorkdaySampleRequisition): {
  summary: string;
  responsibilities: string[];
  requirements: string[];
} {
  return {
    summary: `${row["Job Posting Title"]} (${row["Job Profile"]}) in ${row["Supervisory Organization"]}, ${row.Location}. Imported from the sample Workday export ${row["Job Requisition ID"]} — review and edit before submitting.`,
    responsibilities: [...row.jobDescription],
    requirements: row.skills.map((s) => `Hands-on experience with ${s}`),
  };
}
