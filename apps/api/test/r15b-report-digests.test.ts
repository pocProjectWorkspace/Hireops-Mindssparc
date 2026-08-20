/**
 * R1.5b — scheduled report digests (tenants.settings.reportDigests).
 *
 * The wire contract behind the /admin/report-digests surface. Honesty focus: the
 * block an admin saves is the block the report_digest_scan worker reads —
 * genuinely persisted to the tenant's settings jsonb, normalised exactly as
 * `resolveReportDigests` does (the worker's own resolve must agree, because the
 * outbox dedup keys are built from those recipient strings), and merged as a
 * SIBLING that cannot disturb any other settings block. Exercised over real
 * cloud-minted JWTs (reality #110 — sign in as the seeded personas):
 *
 *   Test 1: admin gating — recruiter is FORBIDDEN on both get and update.
 *   Test 2: resolve-over-defaults — an UNCONFIGURED tenant (key stripped)
 *           resolves to off / weekly / no recipients / 07:00Z rather than
 *           erroring or inventing a schedule.
 *   Test 3: round-trip — update persists a full custom block, get returns it
 *           verbatim, and it is really in the jsonb (not merely echoed);
 *           recipients come back lower-cased, deduped and sorted.
 *   Test 4: SIBLING PRESERVATION — updating reportDigests leaves aiBudget,
 *           systemSetup and an unrelated sentinel key byte-identical. This is
 *           the assertion that catches a botched jsonb merge (a read-modify-
 *           write, or a `SET settings =` that replaces the whole document).
 *
 * kyndryl-poc's settings jsonb is snapshotted in beforeAll and restored verbatim
 * in afterAll, so the demo config is never clobbered. Requires
 * `pnpm db:seed:test-users` (admin1 / recruiter1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const ADMIN = "admin1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

/** Dated synthetic namespace — this run's sentinel key inside settings. */
const SENTINEL_KEY = "r15b_sentinel_20260818";

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
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

interface ReportDigests {
  version: number;
  enabled: boolean;
  cadence: "weekly" | "monthly";
  recipients: string[];
  sendHourUtc: number;
}

let adminJwt: string;
let recruiterJwt: string;
let tenantId: string;
let originalSettings: unknown = {};

async function readSettings(): Promise<Record<string, unknown>> {
  const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId}
  `;
  return row?.settings ?? {};
}

async function stripReportDigests() {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'reportDigests' WHERE id = ${tenantId}
  `;
}

describe("R1.5b — scheduled report digests (settings.reportDigests)", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip anything a prior run / live check left behind.
    // afterAll restores the snapshot verbatim.
    await stripReportDigests();
  });

  afterAll(async () => {
    try {
      await poolSql`
        UPDATE public.tenants
        SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort restore
    }
  });

  it("Test 1: admin-gated — recruiter is FORBIDDEN on get and update", async () => {
    const readDenied = await trpcQuery("getReportDigests", {}, recruiterJwt);
    assert.ok(
      isErr(readDenied) && readDenied.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on getReportDigests: ${JSON.stringify(readDenied)}`,
    );

    const writeDenied = await trpcMutation(
      "updateReportDigests",
      { version: 1, enabled: true, cadence: "weekly", recipients: [], sendHourUtc: 7 },
      recruiterJwt,
    );
    assert.ok(
      isErr(writeDenied) && writeDenied.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on updateReportDigests: ${JSON.stringify(writeDenied)}`,
    );

    // …and the denied write really did not land.
    const settings = await readSettings();
    assert.equal(settings["reportDigests"], undefined, "denied write persisted nothing");
  });

  it("Test 2: an unconfigured tenant resolves to the disabled defaults", async () => {
    await stripReportDigests();
    const get = await trpcQuery<ReportDigests>("getReportDigests", {}, adminJwt);
    assert.ok(!isErr(get), `getReportDigests: ${JSON.stringify(get)}`);
    assert.deepEqual(
      get.result.data,
      { version: 1, enabled: false, cadence: "weekly", recipients: [], sendHourUtc: 7 },
      "resolve merges over the code defaults — nothing sends until an admin opts in",
    );
  });

  it("Test 3: round-trip — update persists, get returns it verbatim, recipients normalised", async () => {
    // Deliberately messy input: mixed case, a duplicate, and out of order. The
    // stored block must be what resolveReportDigests produces, because the
    // worker resolves the SAME way and builds its dedup keys from these strings.
    const up = await trpcMutation<{ ok: true; reportDigests: ReportDigests }>(
      "updateReportDigests",
      {
        version: 1,
        enabled: true,
        cadence: "monthly",
        recipients: ["Sponsor@Example.com", "ops@example.com", "sponsor@example.com"],
        sendHourUtc: 9,
      },
      adminJwt,
    );
    assert.ok(!isErr(up), `updateReportDigests (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.ok, true);

    const expected: ReportDigests = {
      version: 1,
      enabled: true,
      cadence: "monthly",
      recipients: ["ops@example.com", "sponsor@example.com"],
      sendHourUtc: 9,
    };
    assert.deepEqual(
      up.result.data.reportDigests,
      expected,
      "mutation echoes the normalised block (lower-cased, deduped, sorted)",
    );

    const get = await trpcQuery<ReportDigests>("getReportDigests", {}, adminJwt);
    assert.ok(!isErr(get), `getReportDigests: ${JSON.stringify(get)}`);
    assert.deepEqual(get.result.data, expected, "read-back matches the write");

    // Genuinely in the DB jsonb, not merely echoed by the procedure.
    const settings = await readSettings();
    assert.deepEqual(settings["reportDigests"], expected, "persisted to tenants.settings jsonb");
  });

  it("Test 4: the merge leaves sibling settings blocks untouched", async () => {
    // Plant two real sibling blocks + an unrelated sentinel, then prove an
    // update of reportDigests cannot disturb any of them. A read-modify-write
    // (or a whole-document SET) would drop or stale whatever it didn't carry.
    const aiBudget = {
      version: 1,
      enabled: true,
      monthlyBudgetUsd: 123.45,
      alertThresholdPercents: [80, 100],
    };
    const systemSetup = {
      version: 1,
      emailAlerts: { enabled: true, recipients: ["ops@example.com"], alertTypes: ["sla_breach"] },
      escalationRules: [],
    };
    await poolSql`
      UPDATE public.tenants
      SET settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify({
        aiBudget,
        systemSetup,
        [SENTINEL_KEY]: "keep-me",
      })}::jsonb
      WHERE id = ${tenantId}
    `;

    const before = await readSettings();
    const up = await trpcMutation<{ ok: true; reportDigests: ReportDigests }>(
      "updateReportDigests",
      {
        version: 1,
        enabled: false,
        cadence: "weekly",
        recipients: ["board@example.com"],
        sendHourUtc: 6,
      },
      adminJwt,
    );
    assert.ok(!isErr(up), `updateReportDigests: ${JSON.stringify(up)}`);

    const after = await readSettings();
    assert.deepEqual(after["aiBudget"], aiBudget, "aiBudget sibling preserved verbatim");
    assert.deepEqual(after["systemSetup"], systemSetup, "systemSetup sibling preserved verbatim");
    assert.equal(after[SENTINEL_KEY], "keep-me", "unrelated sentinel key preserved");
    assert.deepEqual(
      after["reportDigests"],
      {
        version: 1,
        enabled: false,
        cadence: "weekly",
        recipients: ["board@example.com"],
        sendHourUtc: 6,
      },
      "the block we DID write is updated",
    );

    // Nothing else in the document moved either: every pre-existing key that is
    // not reportDigests survives with the same value.
    for (const key of Object.keys(before)) {
      if (key === "reportDigests") continue;
      assert.deepEqual(after[key], before[key], `settings.${key} untouched by the merge`);
    }
  });
});
