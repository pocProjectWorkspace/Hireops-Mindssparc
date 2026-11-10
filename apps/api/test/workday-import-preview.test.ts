/**
 * Workday import — PURE unit suite (no DB, no AI).
 *
 * Pins the mapping/validation helpers in apps/api/src/lib/workday-import.ts
 * with the tenant lookups injected: grade → comp band, hiring-manager name
 * matching, supervisory org → business unit (exact vs flagged fallback), and
 * the per-row mapped / needs_review status — plus the export-file parser:
 * header aliases, quoted CSV, BOM, blank rows, missing required columns,
 * size / row limits, and a real (hand-zipped) .xlsx workbook.
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { deflateRawSync } from "node:zlib";
import {
  WORKDAY_COLUMN_ALIASES,
  WORKDAY_SAMPLE_REQUISITIONS,
  WORKDAY_UPLOAD_MAX_BYTES,
  WORKDAY_UPLOAD_MAX_ROWS,
  type WorkdayRequisitionRow,
} from "@hireops/api-types";
import {
  buildWorkdayPreviewRow,
  locationToPrimaryLocation,
  mapWorkdayRow,
  matchBusinessUnit,
  matchCompBand,
  matchMemberByName,
  matchWorkdayHeader,
  normaliseName,
  parseCsv,
  parseWorkdayDate,
  parseWorkdayExportFile,
  readXlsxRows,
  targetHireDateIso,
  WorkdayImportFileError,
  workdayJdSections,
  workdayRowsFromTable,
  workdaySampleRows,
  type WorkdayTenantLookups,
} from "../src/lib/workday-import";

const BANDS = [
  { id: "b1", name: "Acme IN09 — Assistant / Analyst", level: "IN09" },
  { id: "b2", name: "Acme IN12 — Specialist / Senior Analyst", level: null },
  { id: "b3", name: "Leadership", level: "Leadership" },
];
const MEMBERS = [
  { membershipId: "m1", displayName: "Suresh Venkataraman" },
  { membershipId: "m2", displayName: "Nisha Balakrishnan" },
  { membershipId: "m3", displayName: null },
];
const UNITS = [
  { id: "u1", name: "GBS India — Hyderabad" },
  { id: "u2", name: "GBS India — Order to Cash" },
];

const TODAY = new Date("2026-10-08T00:00:00Z");
const SAMPLE = workdaySampleRows(WORKDAY_SAMPLE_REQUISITIONS, TODAY);
function sampleRow(i: number): WorkdayRequisitionRow {
  const r = SAMPLE[i];
  if (!r) throw new Error(`missing sample row ${i}`);
  return r;
}
const row0 = sampleRow(0);
const row2 = sampleRow(2);

const csvFile = (text: string, fileName = "export.csv") => ({
  fileName,
  contentBase64: Buffer.from(text, "utf8").toString("base64"),
});

function expectFileError(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof WorkdayImportFileError, `expected WorkdayImportFileError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });
}

describe("workday import — sample data", () => {
  it("ships exactly the three sample requisitions", () => {
    assert.deepEqual(
      WORKDAY_SAMPLE_REQUISITIONS.map((r) => r["Job Requisition ID"]),
      ["JR-24117", "JR-24121", "JR-24130"],
    );
    for (const r of WORKDAY_SAMPLE_REQUISITIONS) {
      assert.ok(r.jobDescription.length >= 3 && r.jobDescription.length <= 5);
      assert.ok(r.skills.length >= 4 && r.skills.length <= 5);
    }
  });

  it("normalises the sample into rows with the target date resolved from today", () => {
    assert.equal(row0.rowNumber, 1);
    assert.equal(row0.jobRequisitionId, "JR-24117");
    assert.equal(row0.numberOfOpenings, "2");
    assert.equal(row0.targetHireDate, "2026-11-19");
  });
});

describe("workday import — matchers", () => {
  it("normalises names (case, dashes, whitespace)", () => {
    assert.equal(normaliseName("  GBS India — Order  to Cash "), "gbs india order to cash");
  });

  it("matches grade to band by level first, then by whole token in name", () => {
    assert.equal(matchCompBand("IN09", BANDS)?.id, "b1");
    assert.equal(matchCompBand("in12", BANDS)?.id, "b2");
    assert.equal(matchCompBand("IN14", BANDS), null);
    // No partial-token match: "IN1" must not hit "IN12".
    assert.equal(matchCompBand("IN1", BANDS), null);
    assert.equal(matchCompBand("", BANDS), null);
  });

  it("matches hiring manager by exact normalised display name only", () => {
    assert.equal(matchMemberByName("suresh  venkataraman", MEMBERS)?.membershipId, "m1");
    assert.equal(matchMemberByName("Suresh", MEMBERS), null);
    assert.equal(matchMemberByName("Suman Reddy", MEMBERS), null);
  });

  it("maps supervisory org to an exact unit, else a flagged fallback", () => {
    const exact = matchBusinessUnit("GBS India — Order to Cash", UNITS);
    assert.equal(exact.unit?.id, "u2");
    assert.equal(exact.exact, true);
    const fallback = matchBusinessUnit("GBS India — Procure to Pay", UNITS);
    assert.equal(fallback.unit?.id, "u1");
    assert.equal(fallback.exact, false);
    const firstUnit = matchBusinessUnit("Corporate Finance", UNITS);
    assert.equal(firstUnit.unit?.id, "u1");
    assert.equal(firstUnit.exact, false);
    assert.equal(matchBusinessUnit("", UNITS).exact, false);
    assert.equal(matchBusinessUnit("Anything", []).unit, null);
  });

  it("derives location and target date", () => {
    assert.equal(locationToPrimaryLocation("Hyderabad, India"), "Hyderabad");
    assert.equal(targetHireDateIso(42, new Date("2026-10-08T10:00:00Z")), "2026-11-19");
  });

  it("parses Workday export dates (ISO, named month, numeric, Excel serial)", () => {
    assert.deepEqual(parseWorkdayDate("2026-11-15"), { iso: "2026-11-15", ambiguous: false });
    assert.deepEqual(parseWorkdayDate("2026-11-15T00:00:00.000-08:00"), {
      iso: "2026-11-15",
      ambiguous: false,
    });
    assert.deepEqual(parseWorkdayDate("15-Nov-2026"), { iso: "2026-11-15", ambiguous: false });
    assert.deepEqual(parseWorkdayDate("15 September 2026"), {
      iso: "2026-09-15",
      ambiguous: false,
    });
    assert.deepEqual(parseWorkdayDate("Nov 15, 2026"), { iso: "2026-11-15", ambiguous: false });
    assert.deepEqual(parseWorkdayDate("11/15/2026"), { iso: "2026-11-15", ambiguous: false });
    assert.deepEqual(parseWorkdayDate("15/11/2026"), { iso: "2026-11-15", ambiguous: false });
    // Both parts ≤ 12 → read month/day but flagged.
    assert.deepEqual(parseWorkdayDate("03/04/2026"), { iso: "2026-03-04", ambiguous: true });
    // Excel serial 46341 = 2026-11-15.
    assert.deepEqual(parseWorkdayDate("46341"), { iso: "2026-11-15", ambiguous: false });
    assert.equal(parseWorkdayDate("next quarter").iso, null);
    assert.equal(parseWorkdayDate("2026-02-30").iso, null);
    assert.equal(parseWorkdayDate("").iso, null);
  });
});

describe("workday import — row mapping", () => {
  const lookups: WorkdayTenantLookups = {
    businessUnits: UNITS,
    members: MEMBERS,
    compBands: BANDS,
  };

  it("marks a fully-resolvable row as mapped with resolved ids", () => {
    const { mapping, resolved } = mapWorkdayRow(row0, lookups, "Ravi");
    const byField = new Map(mapping.map((m) => [m.workdayField, m]));
    assert.equal(byField.get("Supervisory Organization")?.status, "mapped");
    assert.equal(byField.get("Hiring Manager")?.status, "mapped");
    assert.equal(byField.get("Compensation Grade")?.status, "mapped");
    assert.equal(
      byField.get("Compensation Grade")?.hireopsValue,
      "Acme IN09 — Assistant / Analyst",
    );
    assert.equal(byField.get("Worker Type")?.status, "not_imported");
    assert.deepEqual(resolved, {
      title: "Cash Application Analyst",
      businessUnitId: "u2",
      hiringManagerMembershipId: "m1",
      compBandId: "b1",
      primaryLocation: "Hyderabad",
      numberOfOpenings: 2,
      targetStartDate: "2026-11-19",
    });
  });

  it("flags unknown manager, unmatched grade and fallback BU as needs_review", () => {
    const { mapping, resolved } = mapWorkdayRow(row2, lookups, "Ravi");
    const byField = new Map(mapping.map((m) => [m.workdayField, m]));
    assert.equal(byField.get("Hiring Manager")?.status, "needs_review");
    assert.equal(byField.get("Hiring Manager")?.hireopsValue, "Ravi");
    assert.equal(byField.get("Compensation Grade")?.status, "needs_review");
    assert.equal(byField.get("Supervisory Organization")?.status, "needs_review");
    assert.equal(resolved.hiringManagerMembershipId, null);
    assert.equal(resolved.compBandId, null);
    assert.equal(resolved.businessUnitId, "u1");
  });

  it("flags unreadable openings / dates and leaves blanks unimported", () => {
    const odd: WorkdayRequisitionRow = {
      ...row0,
      numberOfOpenings: "two",
      targetHireDate: "ASAP",
      location: "",
    };
    const { mapping, resolved } = mapWorkdayRow(odd, lookups, null);
    const byField = new Map(mapping.map((m) => [m.workdayField, m]));
    assert.equal(byField.get("Number of Openings")?.status, "needs_review");
    assert.equal(byField.get("Target Hire Date")?.status, "needs_review");
    assert.equal(byField.get("Location")?.status, "not_imported");
    assert.equal(resolved.numberOfOpenings, 1);
    assert.equal(resolved.targetStartDate, null);
    assert.equal(resolved.primaryLocation, null);
    const blank = mapWorkdayRow(
      { ...row0, numberOfOpenings: "", targetHireDate: "" },
      lookups,
      null,
    );
    const blankBy = new Map(blank.mapping.map((m) => [m.workdayField, m]));
    assert.equal(blankBy.get("Number of Openings")?.status, "mapped");
    assert.equal(blankBy.get("Target Hire Date")?.status, "not_imported");
  });

  it("builds a preview row with review count and already-imported flag", () => {
    const fresh = buildWorkdayPreviewRow(row2, lookups, null, null);
    assert.equal(fresh.needsReviewCount, 3);
    assert.equal(fresh.alreadyImported, null);
    assert.equal(fresh.rowNumber, 3);
    assert.equal(fresh.fields["Target Hire Date"], "2026-12-03");
    const done = buildWorkdayPreviewRow(
      row0,
      lookups,
      null,
      "00000000-0000-4000-8000-000000000001",
    );
    assert.equal(done.needsReviewCount, 0);
    assert.equal(done.alreadyImported?.requisitionId, "00000000-0000-4000-8000-000000000001");
  });

  it("seeds JD sections from the description + skills, naming the source", () => {
    const s = workdayJdSections(row0, 'the Workday export "reqs.csv"');
    assert.deepEqual(s.responsibilities, row0.jobDescription);
    assert.equal(s.requirements.length, row0.skills.length);
    assert.ok(s.summary.includes("JR-24117"));
    assert.ok(s.summary.includes('"reqs.csv"'));
  });
});

// ─────────────────────────── Export-file parsing ───────────────────────────

describe("workday import — alias table", () => {
  it("has no alias claimed by two fields and requires id + title", () => {
    const seen = new Map<string, string>();
    for (const spec of WORKDAY_COLUMN_ALIASES) {
      for (const alias of [spec.label, ...spec.aliases]) {
        const k = normaliseName(alias);
        const prev = seen.get(k);
        assert.ok(!prev || prev === spec.key, `alias "${alias}" used by ${prev} and ${spec.key}`);
        seen.set(k, spec.key);
      }
    }
    assert.deepEqual(
      WORKDAY_COLUMN_ALIASES.filter((s) => s.required).map((s) => s.key),
      ["jobRequisitionId", "jobPostingTitle"],
    );
  });

  it("matches common Workday report headers case/punctuation-insensitively", () => {
    assert.equal(matchWorkdayHeader("Requisition ID"), "jobRequisitionId");
    assert.equal(matchWorkdayHeader("job requisition id"), "jobRequisitionId");
    assert.equal(matchWorkdayHeader("Job Posting Title"), "jobPostingTitle");
    assert.equal(matchWorkdayHeader("Supervisory Organization"), "supervisoryOrganization");
    assert.equal(matchWorkdayHeader("Grade"), "compensationGrade");
    assert.equal(matchWorkdayHeader("Compensation Grade"), "compensationGrade");
    assert.equal(matchWorkdayHeader("Full/Part Time"), "timeType");
    assert.equal(matchWorkdayHeader("No. of Openings"), "numberOfOpenings");
    assert.equal(matchWorkdayHeader("Target Hire Date"), "targetHireDate");
    assert.equal(matchWorkdayHeader("Cost Center"), null);
  });
});

describe("workday import — CSV parser", () => {
  it("handles quoted fields, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,2,3');
    assert.deepEqual(rows, [
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
      ["1", "2", "3"],
    ]);
  });

  it("detects semicolon and tab delimiters", () => {
    assert.deepEqual(parseCsv("a;b\n1;2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
    assert.deepEqual(parseCsv("a\tb\n1\t2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses a Workday CSV export through the alias table", () => {
    const csv = [
      "﻿Requisition ID,Job Posting Title,Supervisory Organization,Location,Hiring Manager,Grade,Number of Openings,Target Hire Date,Skills,Job Description,Cost Center",
      'JR-1,Payroll Analyst,"Finance — Payroll","Pune, India",Suresh Venkataraman,IN09,3,2026-12-01,"Payroll; SAP HCM; Excel","Run payroll\nReconcile",CC-100',
      ",,,,,,,,,,",
      "",
      "JR-2,AP Clerk,Finance,,,,,,,,",
    ].join("\r\n");
    const parsed = parseWorkdayExportFile(csvFile(csv));
    assert.deepEqual(parsed.unmappedColumns, ["Cost Center"]);
    assert.deepEqual(parsed.rowErrors, []);
    assert.equal(parsed.rows.length, 2);
    const [a, b] = parsed.rows;
    assert.equal(a?.rowNumber, 2);
    assert.equal(a?.jobRequisitionId, "JR-1");
    assert.equal(a?.supervisoryOrganization, "Finance — Payroll");
    assert.equal(a?.location, "Pune, India");
    assert.equal(a?.compensationGrade, "IN09");
    assert.equal(a?.numberOfOpenings, "3");
    assert.deepEqual(a?.skills, ["Payroll", "SAP HCM", "Excel"]);
    assert.deepEqual(a?.jobDescription, ["Run payroll", "Reconcile"]);
    // Blank rows are skipped but row numbers stay true to the file.
    assert.equal(b?.rowNumber, 5);
    assert.equal(b?.jobPostingTitle, "AP Clerk");
    assert.deepEqual(b?.skills, []);
  });

  it("finds the header below report title rows and reports bad / duplicate rows", () => {
    const csv = [
      "Open Requisitions report",
      "Run date: 2026-10-01",
      "Job Requisition ID,Job Posting Title",
      "JR-1,Analyst",
      ",Missing id",
      "JR-3,",
      "JR-1,Analyst again",
    ].join("\n");
    const parsed = parseWorkdayExportFile(csvFile(csv));
    assert.deepEqual(
      parsed.rows.map((r) => r.jobRequisitionId),
      ["JR-1"],
    );
    assert.deepEqual(
      parsed.rowErrors.map((e) => [e.rowNumber, e.jobRequisitionId]),
      [
        [5, null],
        [6, "JR-3"],
        [7, "JR-1"],
      ],
    );
    assert.match(parsed.rowErrors[2]?.message ?? "", /Duplicate of row 4/);
  });

  it("rejects a file missing a required column, naming it", () => {
    expectFileError(
      () => parseWorkdayExportFile(csvFile("Job Requisition ID,Location\nJR-1,Pune")),
      /Missing required column: Job Posting Title\./,
    );
    expectFileError(
      () => parseWorkdayExportFile(csvFile("Name,Location\nx,y")),
      /Missing required columns: Job Requisition ID, Job Posting Title/,
    );
  });

  it("rejects empty files, header-only files, wrong types and over-limit files", () => {
    expectFileError(() => parseWorkdayExportFile(csvFile("\n\n,,\n")), /empty/);
    expectFileError(
      () => parseWorkdayExportFile(csvFile("Job Requisition ID,Job Posting Title\n")),
      /no requisition rows/,
    );
    expectFileError(() => parseWorkdayExportFile(csvFile("a", "reqs.pdf")), /\.csv or \.xlsx/);
    expectFileError(() => parseWorkdayExportFile(csvFile("a", "reqs.xls")), /Legacy \.xls/);
    expectFileError(
      () => parseWorkdayExportFile({ fileName: "a.csv", contentBase64: "not base64!" }),
      /invalid encoding/,
    );

    const tooBig = Buffer.alloc(WORKDAY_UPLOAD_MAX_BYTES + 1, 0x41).toString("base64");
    expectFileError(
      () => parseWorkdayExportFile({ fileName: "big.csv", contentBase64: tooBig }),
      /larger than 5 MB/,
    );

    const lines = ["Job Requisition ID,Job Posting Title"];
    for (let i = 0; i <= WORKDAY_UPLOAD_MAX_ROWS; i++) lines.push(`JR-${i},Analyst ${i}`);
    expectFileError(
      () => parseWorkdayExportFile(csvFile(lines.join("\n"))),
      /2,001 requisition rows; the limit is 2,000/,
    );
    // Exactly at the limit is fine.
    lines.pop();
    assert.equal(parseWorkdayExportFile(csvFile(lines.join("\n"))).rows.length, 2000);
  });

  it("accepts a UTF-16LE CSV (Excel 'Unicode text' save)", () => {
    const text = "Job Requisition ID\tJob Posting Title\nJR-9\tAnalyst — Café";
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const parsed = parseWorkdayExportFile({
      fileName: "export.csv",
      contentBase64: bytes.toString("base64"),
    });
    assert.equal(parsed.rows[0]?.jobPostingTitle, "Analyst — Café");
  });
});

// ─────────────────────────── XLSX ───────────────────────────

/** Minimal DEFLATE zip writer — enough to build a real .xlsx in-test. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 14); // crc (not checked by the reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function xlsx(): Buffer {
  const shared = [
    "Job Requisition ID",
    "Job Posting Title",
    "Target Hire Date",
    "Number of Openings",
    "Skills",
    "JR-700",
    "Treasury Analyst &amp; Ops",
  ];
  return zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml":
      '<workbook xmlns:r="r"><sheets><sheet name="Reqs" sheetId="1" r:id="rId7"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/sheet3.xml"/></Relationships>',
    "xl/sharedStrings.xml": `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet3.xml": [
      "<worksheet><sheetData>",
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>',
      '<row r="3"><c r="A3" t="s"><v>5</v></c><c r="B3" t="s"><v>6</v></c><c r="C3" s="2"><v>46341</v></c><c r="D3"><v>2</v></c><c r="E3" t="inlineStr"><is><r><t>FX</t></r><r><t>; Cash</t></r></is></c></row>',
      "</sheetData></worksheet>",
    ].join(""),
  });
}

describe("workday import — XLSX reader", () => {
  it("reads the first sheet (via workbook rels), shared + inline strings and serial dates", () => {
    const rows = readXlsxRows(xlsx());
    assert.deepEqual(rows[0], [
      "Job Requisition ID",
      "Job Posting Title",
      "Target Hire Date",
      "Number of Openings",
      "Skills",
    ]);
    assert.deepEqual(rows[1], []);
    const parsed = workdayRowsFromTable(rows);
    assert.equal(parsed.rows.length, 1);
    const r = parsed.rows[0];
    assert.ok(r);
    assert.equal(r.rowNumber, 3);
    assert.equal(r.jobRequisitionId, "JR-700");
    assert.equal(r.jobPostingTitle, "Treasury Analyst & Ops");
    assert.equal(r.numberOfOpenings, "2");
    assert.equal(parseWorkdayDate(r.targetHireDate).iso, "2026-11-15");
    assert.deepEqual(r.skills, ["FX", "Cash"]);
  });

  it("reads namespace-prefixed sheet XML (<x:row>) with no workbook rels", () => {
    const book = zip({
      "xl/worksheets/sheet1.xml":
        '<x:worksheet><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Req ID</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t xml:space="preserve">Job Title </x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>JR-1</x:t></x:is></x:c><x:c r="B2" t="inlineStr"><x:is><x:t>Analyst</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>',
    });
    const parsed = workdayRowsFromTable(readXlsxRows(book));
    assert.equal(parsed.rows[0]?.jobRequisitionId, "JR-1");
    assert.equal(parsed.rows[0]?.jobPostingTitle, "Analyst");
  });

  it("parses an uploaded .xlsx end-to-end and rejects a non-zip .xlsx", () => {
    const parsed = parseWorkdayExportFile({
      fileName: "Open Reqs.XLSX",
      contentBase64: xlsx().toString("base64"),
    });
    assert.equal(parsed.rows[0]?.jobRequisitionId, "JR-700");
    expectFileError(
      () => parseWorkdayExportFile(csvFile("Job Requisition ID,Job Posting Title", "x.xlsx")),
      /not a valid \.xlsx/,
    );
  });
});
