/**
 * PC-1 — "Import from Workday" from an UPLOADED export (CSV), end-to-end over
 * real cloud-minted JWTs against the shared test DB.
 *
 *   Test 1: recruiter is FORBIDDEN from the upload preview AND the import
 *           (hiring_manager / admin only, same as createRequisitionDraft).
 *   Test 2: hiring manager previews an uploaded CSV — header aliases resolve,
 *           unknown columns are listed as not imported, a row without a
 *           title is a row error, counts add up.
 *   Test 3: a file missing a required column is a BAD_REQUEST naming it.
 *   Test 4: import (file re-sent, server re-parses) creates drafts with the
 *           Workday provenance; per-row outcomes returned.
 *   Test 5: re-uploading the SAME file shows every row "already imported"
 *           and a second import creates nothing.
 *   Test 6: the built-in sample (demo) preview still works, same role gate.
 *
 * Requires `pnpm db:seed:test-users` (hiringmanager1 / recruiter1). Per-run
 * Workday ids + titles keep runs independent; afterAll removes this run's rows.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import type {
  ImportWorkdayRequisitionsOutput,
  PreviewWorkdayRequisitionImportOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const HIRING_MANAGER = "hiringmanager1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

const RUN = Date.now().toString(36);
const JR1 = `PC1-${RUN}-1`;
const JR2 = `PC1-${RUN}-2`;
const CSV = [
  "﻿Requisition ID,Posting Title,Supervisory Organization,Location,Hiring Manager,Grade,No. of Openings,Target Hire Date,Skills,Cost Center",
  `${JR1},"PC1 Payroll Analyst ${RUN}",Finance,"Pune, India",Nobody Known,ZZ99,2,2027-01-15,"Payroll; Excel",CC-1`,
  `${JR2},"PC1 AP Clerk ${RUN}",Finance,Pune,,,,,,CC-2`,
  `PC1-${RUN}-3,,Finance,,,,,,,CC-3`,
].join("\r\n");
const FILE = {
  fileName: `workday-export-${RUN}.csv`,
  contentBase64: Buffer.from(CSV, "utf8").toString("base64"),
};

let recruiterJwt: string;
let hiringManagerJwt: string;
let tenantId: string;
const createdReqIds: string[] = [];

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
async function trpcQuery<O>(name: string, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

describe("PC-1 Workday export upload", () => {
  beforeAll(async () => {
    [recruiterJwt, hiringManagerJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
  });

  afterAll(async () => {
    try {
      for (const reqId of createdReqIds) {
        const [row] = await poolSql<{ position_id: string; jd_version_id: string }[]>`
          SELECT position_id, jd_version_id FROM public.requisitions WHERE id = ${reqId}
        `;
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${reqId}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${reqId}`;
        if (row?.jd_version_id) {
          await poolSql`DELETE FROM public.jd_versions WHERE id = ${row.jd_version_id}`;
        }
        if (row?.position_id) {
          await poolSql`DELETE FROM public.positions WHERE id = ${row.position_id}`;
        }
      }
    } catch {
      // Best-effort cleanup on the shared DB.
    }
  });

  it("Test 1: recruiter is FORBIDDEN from upload preview and import", async () => {
    const preview = await trpcMutation(
      "previewWorkdayRequisitionUpload",
      { file: FILE },
      recruiterJwt,
    );
    assert.ok(isErr(preview), "recruiter preview must fail");
    assert.equal(preview.error.data.code, "FORBIDDEN");
    const imp = await trpcMutation(
      "importWorkdayRequisitions",
      { jobRequisitionIds: [JR1], file: FILE },
      recruiterJwt,
    );
    assert.ok(isErr(imp), "recruiter import must fail");
    assert.equal(imp.error.data.code, "FORBIDDEN");
  });

  it("Test 2: hiring manager previews an uploaded CSV through the alias table", async () => {
    const res = await trpcMutation<PreviewWorkdayRequisitionImportOutput>(
      "previewWorkdayRequisitionUpload",
      { file: FILE },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const p = res.result.data;
    assert.equal(p.source, "upload");
    assert.equal(p.fileName, FILE.fileName);
    assert.deepEqual(p.unmappedColumns, ["Cost Center"]);
    assert.deepEqual(
      p.rows.map((r) => r.jobRequisitionId),
      [JR1, JR2],
    );
    assert.equal(p.rowErrors.length, 1);
    assert.equal(p.rowErrors[0]?.rowNumber, 4);
    assert.match(p.rowErrors[0]?.message ?? "", /No Job Posting Title/);

    const r1 = p.rows[0];
    assert.ok(r1);
    assert.equal(r1.fields["Job Posting Title"], `PC1 Payroll Analyst ${RUN}`);
    assert.equal(r1.fields["Target Hire Date"], "2027-01-15");
    const byField = new Map(r1.mapping.map((m) => [m.workdayField, m]));
    assert.equal(byField.get("Hiring Manager")?.status, "needs_review");
    assert.equal(byField.get("Compensation Grade")?.status, "needs_review");
    assert.equal(byField.get("Number of Openings")?.hireopsValue, "2");
    assert.equal(r1.alreadyImported, null);

    assert.equal(p.counts.total, 2);
    assert.equal(p.counts.invalid, 1);
    assert.equal(p.counts.alreadyImported, 0);
    assert.equal(p.counts.ready + p.counts.needsReview, 2);
  });

  it("Test 3: a file missing a required column is a BAD_REQUEST naming it", async () => {
    const bad = {
      fileName: "bad.csv",
      contentBase64: Buffer.from("Requisition ID,Location\nJR-1,Pune").toString("base64"),
    };
    const res = await trpcMutation(
      "previewWorkdayRequisitionUpload",
      { file: bad },
      hiringManagerJwt,
    );
    assert.ok(isErr(res), "missing-column file must fail");
    assert.equal(res.error.data.code, "BAD_REQUEST");
    assert.match(res.error.message ?? "", /Missing required column: Job Posting Title/);
  });

  it("Test 4: import re-parses the file and creates drafts with Workday provenance", async () => {
    const res = await trpcMutation<ImportWorkdayRequisitionsOutput>(
      "importWorkdayRequisitions",
      { jobRequisitionIds: [JR1, JR2, `PC1-${RUN}-nope`], file: FILE },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    const out = res.result.data;
    for (const r of out.results)
      if (r.requisitionId && r.outcome === "created") createdReqIds.push(r.requisitionId);
    assert.equal(out.createdCount, 2, JSON.stringify(out.results));
    assert.equal(out.skippedCount, 1);
    assert.deepEqual(
      out.results.map((r) => [r.jobRequisitionId, r.outcome]),
      [
        [JR1, "created"],
        [JR2, "created"],
        [`PC1-${RUN}-nope`, "skipped"],
      ],
    );

    const firstReqId = createdReqIds[0];
    assert.ok(firstReqId);
    const [t] = await poolSql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM public.requisition_state_transitions
      WHERE requisition_id = ${firstReqId} AND to_status = 'draft'
    `;
    assert.equal(t?.metadata.workdayJobRequisitionId, JR1);
    assert.equal(t?.metadata.workdayExportFileName, FILE.fileName);
    const [req] = await poolSql<{ number_of_openings: number; target_start_date: string | null }[]>`
      SELECT number_of_openings, target_start_date::text AS target_start_date
      FROM public.requisitions WHERE id = ${firstReqId}
    `;
    assert.equal(Number(req?.number_of_openings), 2);
    assert.equal(req?.target_start_date, "2027-01-15");
    const skills = await poolSql<{ skill_name: string }[]>`
      SELECT s.skill_name FROM public.jd_skills s
      JOIN public.requisitions r ON r.jd_version_id = s.jd_version_id
      WHERE r.id = ${firstReqId} ORDER BY s.skill_name
    `;
    assert.deepEqual(
      skills.map((s) => s.skill_name),
      ["Excel", "Payroll"],
    );
    assert.ok(tenantId);
  });

  it("Test 5: re-uploading the same file shows 'already imported'; re-import is a no-op", async () => {
    const res = await trpcMutation<PreviewWorkdayRequisitionImportOutput>(
      "previewWorkdayRequisitionUpload",
      { file: FILE },
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.counts.alreadyImported, 2);
    assert.ok(res.result.data.rows.every((r) => r.alreadyImported !== null));

    const again = await trpcMutation<ImportWorkdayRequisitionsOutput>(
      "importWorkdayRequisitions",
      { jobRequisitionIds: [JR1, JR2], file: FILE },
      hiringManagerJwt,
    );
    assert.ok(!isErr(again), `expected success, got ${JSON.stringify(again)}`);
    assert.equal(again.result.data.createdCount, 0);
    assert.equal(again.result.data.alreadyImportedCount, 2);
    assert.deepEqual(
      again.result.data.results.map((r) => r.requisitionId).sort(),
      [...createdReqIds].sort(),
    );
  });

  it("Test 6: the sample (demo) preview stays available, same role gate", async () => {
    const denied = await trpcQuery("previewWorkdayRequisitionImport", recruiterJwt);
    assert.ok(isErr(denied), "recruiter sample preview must fail");
    assert.equal(denied.error.data.code, "FORBIDDEN");
    const res = await trpcQuery<PreviewWorkdayRequisitionImportOutput>(
      "previewWorkdayRequisitionImport",
      hiringManagerJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.source, "sample");
    assert.equal(res.result.data.fileName, null);
    assert.equal(res.result.data.counts.total, 3);
    assert.deepEqual(res.result.data.unmappedColumns, []);
  });
});
