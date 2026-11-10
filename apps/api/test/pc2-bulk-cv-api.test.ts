/**
 * PC-2 — bulk CV upload API: role gate + tenant scoping.
 *
 * REST  POST /api/upload/bulk-cv   (multipart, real JWTs via Supabase sign-in)
 * tRPC  listBulkCvBatches / getBulkCvBatch / retryBulkCvItems
 *
 * Coverage:
 *   1. no JWT → 401; hiring manager (not a Candidates-surface role) → 403;
 *      the same caller is FORBIDDEN on the tRPC reads.
 *   2. a requisition in ANOTHER tenant → 404 on upload and NOT_FOUND on
 *      listBulkCvBatches (never a cross-tenant existence leak).
 *   3. a new batch without the attestation → 400 attestation_required.
 *   4. recruiter happy path on an open req in their own tenant: one PDF + one
 *      .zip (a CV, a non-CV, a traversal name) → batch created, 2 queued,
 *      2 skipped with reasons; a continuation request with the SAME file →
 *      'duplicate' same_file_in_batch; getBulkCvBatch returns the per-file
 *      rows; the batch records uploader + attestation version.
 *   5. a batch belonging to another tenant → NOT_FOUND on getBulkCvBatch and
 *      retryBulkCvItems, and a continuation upload naming it → 404.
 *
 * Requires `pnpm db:seed:test-users` and migration 0123. Uses the kyndryl-poc
 * tenant's first open requisition for the happy path and deletes every batch
 * it created in afterAll. The synthetic "other tenant" is the c2a namespace.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { crc32, deflateRawSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { sql as poolSql } from "@hireops/db";
import { BULK_CV_ATTESTATION_VERSION } from "@hireops/api-types";
import { app } from "../src/index.js";
import { resetStorageClient } from "../src/lib/storage";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const HM = "hiringmanager1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

// Other tenant (c2a namespace).
const OT = "00000000-0000-4000-8000-000000c2a001";
const OT_BU = "00000000-0000-4000-8000-000000c2a002";
const OT_MEM = "00000000-0000-4000-8000-000000c2a003";
const OT_POS = "00000000-0000-4000-8000-000000c2a004";
const OT_JD = "00000000-0000-4000-8000-000000c2a005";
const OT_REQ = "00000000-0000-4000-8000-000000c2a006";
const OT_BATCH = "00000000-0000-4000-8000-000000c2a007";
const OT_ITEM = "00000000-0000-4000-8000-000000c2a008";

let recruiterJwt: string;
let hmJwt: string;
let ownReqId: string;
let fkUserId: string;
const createdBatches: string[] = [];

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, { headers: { Authorization: `Bearer ${jwt}` } });
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
function errCode(r: TRPCSuccess<unknown> | TRPCErr): string | null {
  return "error" in r ? r.error.data.code : null;
}

/** Tiny STORED zip writer (enough for the route test). */
function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = deflateRawSync(e.data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6);
    loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc32(e.data), 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(e.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc32(e.data), 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const RUN = Date.now().toString(36);
const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n% pc2 ${RUN} ${tag}\n%%EOF\n`);

async function postUpload(
  jwt: string | null,
  fields: Record<string, string>,
  files: { name: string; data: Buffer; type: string }[],
) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files)
    fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
  const res = await app.request("/api/upload/bulk-cv", {
    method: "POST",
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
    body: fd,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function cleanupOther(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.bulk_cv_items WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.bulk_cv_batches WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${OT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${OT}`;
}

describe("PC-2 bulk CV upload — role gate + tenant scoping", () => {
  beforeAll(async () => {
    resetStorageClient();
    [recruiterJwt, hmJwt] = await Promise.all([signIn(RECRUITER), signIn(HM)]);

    const [req] = await poolSql<{ id: string }[]>`
      SELECT r.id::text AS id FROM public.requisitions r
      JOIN public.tenants t ON t.id = r.tenant_id
      WHERE t.slug = ${TENANT_SLUG} AND r.status IN ('approved', 'posted')
      ORDER BY r.created_at LIMIT 1
    `;
    if (!req) throw new Error(`no open requisition in ${TENANT_SLUG}`);
    ownReqId = req.id;

    const [u] = await poolSql<
      { id: string }[]
    >`SELECT id FROM auth.users WHERE email = ${RECRUITER}`;
    if (!u) throw new Error("recruiter1 missing");
    fkUserId = u.id;

    await cleanupOther();
    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${OT}, 'synth-pc2-other', 'PC2 Other', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${OT_BU}, ${OT}, 'O BU', 'o-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${OT_MEM}, ${OT}, ${fkUserId}, ARRAY['hiring_manager']::tenant_role[], 'active', ${OT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${OT_POS}, ${OT}, ${OT_BU}, 'Other Role', 'onsite', 'Pune', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${OT_JD}, ${OT}, ${OT_POS}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${OT_REQ}, ${OT}, ${OT_POS}, ${OT_JD}, ${OT_MEM}, ${OT_MEM}, 'posted', true)`;
    await poolSql`INSERT INTO public.bulk_cv_batches (id, tenant_id, requisition_id, uploaded_by_user_id, attestation_version) VALUES (${OT_BATCH}, ${OT}, ${OT_REQ}, ${fkUserId}, 'test-v1')`;
    await poolSql`INSERT INTO public.bulk_cv_items (id, tenant_id, batch_id, requisition_id, file_name, storage_key, status, failure_reason) VALUES (${OT_ITEM}, ${OT}, ${OT_BATCH}, ${OT_REQ}, 'x.pdf', 'resumes/bulk/x.pdf', 'failed', 'unreadable_cv')`;
  });

  afterAll(async () => {
    try {
      for (const id of createdBatches) {
        await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ${id}`;
        await poolSql`DELETE FROM public.bulk_cv_batches WHERE id = ${id}`;
      }
      await cleanupOther();
    } finally {
      resetStorageClient();
      await poolSql.end({ timeout: 10 });
    }
  });

  it("1. no JWT → 401; hiring manager → 403 on upload and FORBIDDEN on the reads", async () => {
    const files = [{ name: "a.pdf", data: pdf("a"), type: "application/pdf" }];
    const anon = await postUpload(null, { requisitionId: ownReqId, attested: "true" }, files);
    assert.equal(anon.status, 401);
    const hm = await postUpload(hmJwt, { requisitionId: ownReqId, attested: "true" }, files);
    assert.equal(hm.status, 403);
    assert.equal(
      errCode(await trpcQuery("listBulkCvBatches", { requisitionId: ownReqId }, hmJwt)),
      "FORBIDDEN",
    );
    assert.equal(
      errCode(await trpcQuery("getBulkCvBatch", { batchId: OT_BATCH }, hmJwt)),
      "FORBIDDEN",
    );
    assert.equal(
      errCode(await trpcMutation("retryBulkCvItems", { batchId: OT_BATCH }, hmJwt)),
      "FORBIDDEN",
    );
  });

  it("2. another tenant's requisition → 404 / NOT_FOUND", async () => {
    const r = await postUpload(recruiterJwt, { requisitionId: OT_REQ, attested: "true" }, [
      { name: "a.pdf", data: pdf("x"), type: "application/pdf" },
    ]);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "requisition_not_found");
    assert.equal(
      errCode(await trpcQuery("listBulkCvBatches", { requisitionId: OT_REQ }, recruiterJwt)),
      "NOT_FOUND",
    );
  });

  it("3. a new batch needs the attestation", async () => {
    const r = await postUpload(recruiterJwt, { requisitionId: ownReqId }, [
      { name: "a.pdf", data: pdf("a"), type: "application/pdf" },
    ]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "attestation_required");
  });

  it("4. recruiter: PDF + zip → batch; continuation dedups the same bytes; per-file reads", async () => {
    const cv = pdf("anita");
    const zip = makeZip([
      { name: "agency/ravi.pdf", data: pdf("ravi") },
      { name: "agency/notes.txt", data: Buffer.from("not a cv") },
      { name: "../escape.pdf", data: pdf("evil") },
    ]);
    const first = await postUpload(recruiterJwt, { requisitionId: ownReqId, attested: "true" }, [
      { name: "anita.pdf", data: cv, type: "application/pdf" },
      { name: "agency.zip", data: zip, type: "application/zip" },
    ]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const batchId = first.body.batchId as string;
    createdBatches.push(batchId);
    assert.equal(first.body.accepted, 2);
    const skipped = Object.fromEntries(
      (first.body.skipped as { fileName: string; reason: string }[]).map((s) => [
        s.fileName,
        s.reason,
      ]),
    );
    assert.equal(skipped["agency.zip/agency/notes.txt"], "not_a_cv_type");
    assert.equal(skipped["agency.zip/../escape.pdf"], "unsafe_path");

    const again = await postUpload(recruiterJwt, { requisitionId: ownReqId, batchId }, [
      { name: "anita-copy.pdf", data: cv, type: "application/pdf" },
    ]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.accepted, 0);

    const got = await trpcQuery<{
      batch: { counts: Record<string, number>; uploadedByUserId: string };
      items: { fileName: string; status: string; outcomeDetail: string | null }[];
    }>("getBulkCvBatch", { batchId }, recruiterJwt);
    assert.ok(!("error" in got), JSON.stringify(got));
    const data = got.result.data;
    assert.equal(data.batch.uploadedByUserId, fkUserId);
    assert.equal(data.batch.counts.total, 5);
    assert.equal(data.batch.counts.skipped, 2);
    const copy = data.items.find((i) => i.fileName === "anita-copy.pdf");
    assert.equal(copy?.status, "duplicate");
    assert.equal(copy?.outcomeDetail, "same_file_in_batch");

    const [row] = await poolSql<
      { attestation_version: string; uploaded_by_membership_id: string | null }[]
    >`
      SELECT attestation_version, uploaded_by_membership_id::text AS uploaded_by_membership_id
      FROM public.bulk_cv_batches WHERE id = ${batchId}
    `;
    assert.equal(row?.attestation_version, BULK_CV_ATTESTATION_VERSION);
    assert.ok(row?.uploaded_by_membership_id, "uploader membership recorded");

    const listed = await trpcQuery<{ batches: { id: string }[]; acceptingUploads: boolean }>(
      "listBulkCvBatches",
      { requisitionId: ownReqId },
      recruiterJwt,
    );
    assert.ok(!("error" in listed));
    assert.equal(listed.result.data.acceptingUploads, true);
    assert.ok(listed.result.data.batches.some((b) => b.id === batchId));
  });

  it("5. another tenant's batch is invisible: NOT_FOUND on read + retry, 404 on continuation", async () => {
    assert.equal(
      errCode(await trpcQuery("getBulkCvBatch", { batchId: OT_BATCH }, recruiterJwt)),
      "NOT_FOUND",
    );
    assert.equal(
      errCode(await trpcMutation("retryBulkCvItems", { batchId: OT_BATCH }, recruiterJwt)),
      "NOT_FOUND",
    );
    const [item] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.bulk_cv_items WHERE id = ${OT_ITEM}
    `;
    assert.equal(item?.status, "failed", "the foreign item was not re-queued");

    const r = await postUpload(recruiterJwt, { requisitionId: ownReqId, batchId: OT_BATCH }, [
      { name: "b.pdf", data: pdf("b"), type: "application/pdf" },
    ]);
    assert.equal(r.status, 404);
  });
});
