/**
 * PC-13 — Workday handoff record.
 *
 * Part 1 (pure, no DB): CSV rendering — column order follows the platform
 * default WORKDAY_HANDOFF_DEFAULT_COLUMNS, RFC-4180 escaping of commas / quotes
 * / newlines, status derivation, record build (payload snapshot wins over live
 * rows; Workday JR id wins over the HireOps req id), minor-unit formatting.
 *
 * Part 2 (HTTP over app.request, real JWTs): getWorkdayHandoff +
 * exportWorkdayHandoffs — role gate (hiring_manager FORBIDDEN, recruiter OK),
 * "Sent to Workday (simulated)" for an accepted offer with a drained outbox
 * row, "Offer-ready (pre-approval)" for a drafted offer, bulk export narrowed
 * to a requisition.
 *
 * The outbox row is inserted already 'simulated' so the deployed workday drain
 * on the shared DB never claims it. Own fixture block ('0c13') + email marker.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { WORKDAY_HANDOFF_DEFAULT_COLUMNS, type WorkdayHandoffRecord } from "@hireops/api-types";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  buildWorkdayHandoffCsv,
  buildWorkdayHandoffRecord,
  dateRangeBounds,
  deriveWorkdayHandoffStatus,
  formatMinorUnits,
  workdayHandoffJson,
  type WorkdayHandoffSource,
} from "../src/lib/workday-handoff";

// ═══════════════════════════ Part 1 — pure ═══════════════════════════

function baseSource(over: Partial<WorkdayHandoffSource> = {}): WorkdayHandoffSource {
  return {
    applicationId: "11111111-1111-4111-8111-111111111111",
    candidateId: "22222222-2222-4222-8222-222222222222",
    requisitionId: "33333333-3333-4333-8333-333333333333",
    applicationSource: "career_site",
    fullName: "Live Name",
    email: "live@example.test",
    phone: "+91 90000 00000",
    positionTitle: "Live Title",
    positionLevel: "L3",
    primaryLocation: "Hyderabad",
    businessUnitName: "Live BU",
    bandName: "Band Name",
    bandLevel: "IN09",
    hiringManagerMembershipId: "hm-1",
    recruiterMembershipId: "rec-1",
    workdayJobRequisitionId: null,
    offerStatus: "accepted",
    offerBasePaise: "420000000",
    offerJoiningDate: "2026-12-01",
    offerLocation: "Pune",
    outboxId: null,
    outboxStatus: null,
    outboxPayload: null,
    outboxResponse: null,
    outboxCreatedAt: null,
    outboxSimulatedAt: null,
    outboxClaimedBy: null,
    ...over,
  };
}
const NAMES = new Map<string, string | null>([
  ["hm-1", "Hiring Manager One"],
  ["rec-1", "Recruiter One"],
]);
const AT = new Date("2026-11-10T09:30:00.000Z");

describe("PC-13 workday handoff — pure", () => {
  it("renders the header row in the platform-default column order", () => {
    const csv = buildWorkdayHandoffCsv([]);
    assert.equal(csv, WORKDAY_HANDOFF_DEFAULT_COLUMNS.map((c) => c.header).join(","));
    // Spot-check the Workday-friendly names and the order of the first columns.
    assert.deepEqual(csv.split(",").slice(0, 5), [
      "Candidate ID",
      "Legal Name",
      "Email",
      "Phone",
      "Job Requisition ID",
    ]);
  });

  it("escapes commas, quotes and newlines (RFC 4180) and keeps row order", () => {
    const rec = buildWorkdayHandoffRecord(
      baseSource({ fullName: 'Rao, "Ravi" K', positionTitle: "Analyst\nO2C" }),
      NAMES,
      AT,
    );
    const csv = buildWorkdayHandoffCsv([rec, { ...rec, candidateId: "second" }]);
    const lines = csv.split("\r\n");
    // Records are CRLF-separated; the embedded LF stays inside its quoted field.
    assert.equal(lines.length, 1 + 2, "header + 2 rows");
    assert.ok(csv.includes('"Rao, ""Ravi"" K"'), "comma + quote field quoted, quotes doubled");
    assert.ok(csv.includes('"Analyst\nO2C"'), "newline field quoted");
    assert.ok(!csv.endsWith("\r\n"), "no trailing newline");
    assert.ok(lines[1]?.startsWith("22222222-2222-4222-8222-222222222222,"));
    assert.ok(lines[2]?.startsWith("second,"));
  });

  it("honours a replacement column list (tenant mapping seam)", () => {
    const rec = buildWorkdayHandoffRecord(baseSource(), NAMES, AT);
    const csv = buildWorkdayHandoffCsv(
      [rec],
      [
        { key: "email", header: "Primary Email" },
        { key: "legalName", header: "Worker Name" },
      ],
    );
    assert.equal(csv, "Primary Email,Worker Name\r\nlive@example.test,Live Name");
    assert.deepEqual(
      Object.keys(workdayHandoffJson(rec)),
      WORKDAY_HANDOFF_DEFAULT_COLUMNS.map((c) => c.header),
    );
  });

  it("derives handoff status from outbox first, then offer", () => {
    assert.equal(deriveWorkdayHandoffStatus("pending", "accepted"), "ready");
    assert.equal(deriveWorkdayHandoffStatus("processing", "accepted"), "ready");
    assert.equal(deriveWorkdayHandoffStatus("simulated", "accepted"), "sent_simulated");
    assert.equal(deriveWorkdayHandoffStatus("sent", "accepted"), "sent");
    assert.equal(deriveWorkdayHandoffStatus("failed", "accepted"), "failed");
    assert.equal(deriveWorkdayHandoffStatus(null, "accepted"), "ready");
    assert.equal(deriveWorkdayHandoffStatus(null, "drafted"), "offer_ready");
    assert.equal(deriveWorkdayHandoffStatus(null, "extended"), "offer_ready");
    assert.equal(deriveWorkdayHandoffStatus(null, null), "none");
  });

  it("prefers the queued payload snapshot and the Workday JR id", () => {
    const rec: WorkdayHandoffRecord = buildWorkdayHandoffRecord(
      baseSource({
        workdayJobRequisitionId: "JR-24117",
        outboxId: "44444444-4444-4444-8444-444444444444",
        outboxStatus: "simulated",
        outboxPayload: {
          pre_hire: { full_name: "Payload Name", email: "p@example.test", phone: "1" },
          position: {
            title: "Payload Title",
            business_unit_name: "Payload BU",
            location: "Chennai",
          },
          effective_date: "2027-01-04",
          compensation: { base_annual_inr_paise: 123456789, currency: "INR" },
        },
        outboxResponse: { workday_reference: { wid: "wid-123", descriptor: "Pre-Hire: X" } },
      }),
      NAMES,
      AT,
    );
    assert.equal(rec.legalName, "Payload Name");
    assert.equal(rec.jobTitle, "Payload Title");
    assert.equal(rec.businessUnit, "Payload BU");
    assert.equal(rec.location, "Chennai");
    assert.equal(rec.proposedStartDate, "2027-01-04");
    assert.equal(rec.basePay, "1234567.89");
    assert.equal(rec.currency, "INR");
    assert.equal(rec.jobRequisitionId, "JR-24117");
    assert.equal(rec.hireopsRequisitionId, "33333333-3333-4333-8333-333333333333");
    assert.equal(rec.grade, "IN09");
    assert.equal(rec.hiringManager, "Hiring Manager One");
    assert.equal(rec.recruiter, "Recruiter One");
    assert.equal(rec.source, "Career Site");
    assert.equal(rec.handoffStatus, "Sent to Workday (simulated)");
    assert.equal(rec.workdayReference, "wid-123");
    assert.equal(rec.generatedAt, "2026-11-10T09:30:00.000Z");
  });

  it("falls back to live rows (pre-approval) and the HireOps req id", () => {
    const rec = buildWorkdayHandoffRecord(baseSource({ offerStatus: "drafted" }), NAMES, AT);
    assert.equal(rec.legalName, "Live Name");
    assert.equal(rec.location, "Pune");
    assert.equal(rec.basePay, "4200000.00");
    assert.equal(rec.jobRequisitionId, "33333333-3333-4333-8333-333333333333");
    assert.equal(rec.handoffStatus, "Offer-ready (pre-approval)");
    assert.equal(rec.workdayReference, null);
  });

  it("formats minor units and date bounds", () => {
    assert.equal(formatMinorUnits(5), "0.05");
    assert.equal(formatMinorUnits("100"), "1.00");
    assert.equal(formatMinorUnits(null), null);
    const b = dateRangeBounds("2026-11-01", "2026-11-10");
    assert.equal(b.fromTs?.toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(b.toTsExclusive?.toISOString(), "2026-11-11T00:00:00.000Z");
  });
});

// ═══════════════════════════ Part 2 — API ═══════════════════════════

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env: ${name}`);
  return v;
}
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_ANON_KEY = requireEnv("SUPABASE_ANON_KEY");

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const HIRING_MANAGER = "hiringmanager1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

const FX_BU = "00000000-0000-4000-8000-00000c130001";
const FX_POSITION = "00000000-0000-4000-8000-00000c130002";
const FX_JD = "00000000-0000-4000-8000-00000c130003";
const FX_REQ = "00000000-0000-4000-8000-00000c130004";
const EMAIL_MARKER = "@pc13.test";

let recruiterJwt: string;
let hmJwt: string;
let tenantId: string;
let recruiterMembershipId: string;

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
function dataOf<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}
async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface HandoffOut {
  status: string;
  statusLabel: string;
  outboxId: string | null;
  sentAt: string | null;
  workdayReference: string | null;
  processedBy: string | null;
  csv: string | null;
  json: Record<string, string | null> | null;
  record: WorkdayHandoffRecord | null;
}

async function seedApplication(opts: {
  suffix: string;
  name: string;
  offerStatus: "accepted" | "drafted" | null;
  simulatedOutbox?: boolean;
}): Promise<string> {
  const personId = randomUUID();
  const candidateId = randomUUID();
  const applicationId = randomUUID();
  const email = `${opts.suffix}${EMAIL_MARKER}`;
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${personId}, ${tenantId}, ${opts.name}, ${email}, ${email}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candidateId}, ${tenantId}, ${personId}, 'referral', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${applicationId}, ${tenantId}, ${candidateId}, ${FX_REQ}, 'referral',
            ${opts.offerStatus === "accepted" ? "offer_accepted" : "offer_drafted"}, now())
  `;
  if (opts.offerStatus) {
    await poolSql`
      INSERT INTO public.offers
        (tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, accepted_at)
      VALUES (${tenantId}, ${applicationId}, ${recruiterMembershipId}, ${1_800_000 * 100},
              '2026-12-01', 'Hyderabad, India', now() + interval '7 days', ${opts.offerStatus},
              CASE WHEN ${opts.offerStatus} = 'accepted' THEN now() ELSE NULL END)
    `;
  }
  if (opts.simulatedOutbox) {
    const payload = {
      pre_hire: { full_name: opts.name, email, phone: null },
      position: {
        requisition_external_id: FX_REQ,
        title: "PC13 Analyst",
        business_unit_name: "PC13 BU",
        location: "Hyderabad, India",
      },
      effective_date: "2026-12-01",
      compensation: { base_annual_inr_paise: 1_800_000 * 100, currency: "INR" },
      source: { application_id: applicationId },
    };
    const response = {
      status: "success",
      workday_reference: { type: "Pre-Hire", wid: "pc13-wid-0001", descriptor: "Pre-Hire" },
      simulation_notes: "simulated",
    };
    await poolSql`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, subject_application_id, payload, status,
         attempt_count, claimed_by, claimed_at, simulated_at, simulated_response)
      VALUES (${tenantId}, 'hire_employee', ${"hire:application:" + applicationId},
              ${applicationId}, ${JSON.stringify(payload)}::jsonb, 'simulated', 1,
              'workday-sim-pc13test', now(), now(), ${JSON.stringify(response)}::jsonb)
    `;
  }
  return applicationId;
}

async function cleanup(): Promise<void> {
  const appIds = poolSql`SELECT id FROM public.applications WHERE requisition_id = ${FX_REQ}`;
  await poolSql`DELETE FROM public.workday_sync_outbox WHERE subject_application_id IN (${appIds})`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id IN (${appIds})`;
  await poolSql`DELETE FROM public.offers WHERE application_id IN (${appIds})`;
  await poolSql`DELETE FROM public.applications WHERE requisition_id = ${FX_REQ}`;
  await poolSql`
    DELETE FROM public.candidates
    WHERE tenant_id = ${tenantId}
      AND person_id IN (SELECT id FROM public.persons WHERE email_normalised LIKE ${"%" + EMAIL_MARKER})
  `;
  await poolSql`
    DELETE FROM public.persons
    WHERE tenant_id = ${tenantId} AND email_normalised LIKE ${"%" + EMAIL_MARKER}
  `;
  await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${FX_REQ}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${FX_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${FX_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${FX_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${FX_BU}`;
}

describe("PC-13 workday handoff — API", () => {
  beforeAll(async () => {
    [recruiterJwt, hmJwt] = await Promise.all([signIn(RECRUITER), signIn(HIRING_MANAGER)]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${tenantId} AND au.email = ${RECRUITER} LIMIT 1
    `;
    if (!m) throw new Error(`membership for ${RECRUITER} not found`);
    recruiterMembershipId = m.id;

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${FX_BU}, ${tenantId}, 'PC13 BU', 'pc13-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${FX_POSITION}, ${tenantId}, ${FX_BU}, 'PC13 Analyst', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${FX_JD}, ${tenantId}, ${FX_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${FX_REQ}, ${tenantId}, ${FX_POSITION}, ${FX_JD}, ${recruiterMembershipId},
              ${recruiterMembershipId}, 'posted')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("forbids a hiring manager on both procedures (role gate)", async () => {
    const appId = await seedApplication({ suffix: "gate", name: "Gate Person", offerStatus: null });
    const one = await trpcQuery<HandoffOut>("getWorkdayHandoff", { applicationId: appId }, hmJwt);
    assert.ok(isErr(one), "hiring manager should be forbidden");
    assert.equal(one.error.data.code, "FORBIDDEN");
    const bulk = await trpcQuery("exportWorkdayHandoffs", { requisitionId: FX_REQ }, hmJwt);
    assert.ok(isErr(bulk), "hiring manager should be forbidden on export");
    assert.equal(bulk.error.data.code, "FORBIDDEN");
  });

  it("returns 'none' with no record when there is no live offer", async () => {
    const appId = await seedApplication({ suffix: "none", name: "No Offer", offerStatus: null });
    const out = dataOf(
      await trpcQuery<HandoffOut>("getWorkdayHandoff", { applicationId: appId }, recruiterJwt),
    );
    assert.equal(out.status, "none");
    assert.equal(out.record, null);
    assert.equal(out.csv, null);
  });

  it("shows 'Sent to Workday (simulated)' with WID + worker id for a drained hire", async () => {
    const appId = await seedApplication({
      suffix: "sent",
      name: "Sent, Person",
      offerStatus: "accepted",
      simulatedOutbox: true,
    });
    const out = dataOf(
      await trpcQuery<HandoffOut>("getWorkdayHandoff", { applicationId: appId }, recruiterJwt),
    );
    assert.equal(out.status, "sent_simulated");
    assert.equal(out.statusLabel, "Sent to Workday (simulated)");
    assert.ok(out.outboxId);
    assert.ok(out.sentAt);
    assert.equal(out.workdayReference, "pc13-wid-0001");
    assert.equal(out.processedBy, "workday-sim-pc13test");
    assert.equal(out.record?.basePay, "1800000.00");
    assert.equal(out.record?.currency, "INR");
    assert.equal(out.record?.jobRequisitionId, FX_REQ);
    assert.equal(out.record?.source, "Referral");
    assert.ok(out.record?.recruiter, "recruiter name resolved");
    assert.equal(out.json?.["Legal Name"], "Sent, Person");
    const [header, row] = (out.csv ?? "").split("\r\n");
    assert.equal(header, WORKDAY_HANDOFF_DEFAULT_COLUMNS.map((c) => c.header).join(","));
    assert.ok(row?.includes('"Sent, Person"'), "comma-bearing name is quoted in the CSV");
  });

  it("marks a drafted offer 'Offer-ready (pre-approval)'", async () => {
    const appId = await seedApplication({
      suffix: "draft",
      name: "Draft Person",
      offerStatus: "drafted",
    });
    const out = dataOf(
      await trpcQuery<HandoffOut>("getWorkdayHandoff", { applicationId: appId }, recruiterJwt),
    );
    assert.equal(out.status, "offer_ready");
    assert.equal(out.outboxId, null);
    assert.equal(out.record?.handoffStatus, "Offer-ready (pre-approval)");
    assert.equal(out.record?.location, "Hyderabad, India");
  });

  it("bulk-exports queued records for a requisition as one CSV", async () => {
    const out = dataOf(
      await trpcQuery<{ csv: string; rowCount: number; truncated: boolean; filename: string }>(
        "exportWorkdayHandoffs",
        { requisitionId: FX_REQ, status: "sent" },
        recruiterJwt,
      ),
    );
    // Only the simulated-outbox application is queued; drafted / none are not.
    assert.equal(out.rowCount, 1);
    assert.equal(out.truncated, false);
    assert.ok(out.filename.endsWith(".csv"));
    assert.equal(out.csv.split("\r\n").length, 2);
    assert.ok(out.csv.includes('"Sent, Person"'));

    const pending = dataOf(
      await trpcQuery<{ rowCount: number }>(
        "exportWorkdayHandoffs",
        { requisitionId: FX_REQ, status: "pending" },
        recruiterJwt,
      ),
    );
    assert.equal(pending.rowCount, 0);
  });
});
