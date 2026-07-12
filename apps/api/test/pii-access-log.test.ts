/**
 * PII-01 tests — pii_access_log recording + append-only + isolation.
 *
 * Coverage (4 cases):
 *   1. getCandidateById records exactly one pii_access_log row with the
 *      right shape (entity 'candidate', actor 'user', reason, fields).
 *   2. pii_access_log is append-only under the authenticated role —
 *      UPDATE / DELETE affect 0 rows (split RLS policies, no UPDATE/DELETE).
 *   3. Tenant isolation on SELECT — a caller sees only its own tenant's rows.
 *   4. getIntegrationCredential records a row with the caller-supplied label,
 *      and with the default 'service_role' / 'unspecified' label when the
 *      access context is omitted.
 *
 * Recording is fire-and-forget (like withAudit) on the unscoped pool, so the
 * assertions that follow a triggering call poll briefly for the async write.
 *
 * Test mode: NODE_ENV=test forces the LocalKmsClient so the credential
 * round-trip works in-process (same as tenant-context.test.ts Test 15).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db,
  piiAccessLog,
  withTenantContext,
  storeIntegrationCredential,
  getIntegrationCredential,
  type PiiAccessLog,
  type JwtClaims,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY (set in workspace-root .env)");
}

// PII-01 synthetic second tenant (isolation + credential tests). Hex-only
// suffix; '0f11' ~ "pii". UUIDv4-valid structure (version '4', variant '8').
const PII_SYNTH_TENANT = "00000000-0000-4000-8000-00000f110001";
// Candidate for Test 1 lives in the caller's real tenant (needs a real JWT
// session so getCandidateById's protectedProcedure passes RLS).
const CAND_PII_UUID = "00000000-0000-4000-8000-00000f110010";

let jwt: string;
let decodedClaims: JwtClaims;
let testUserId: string;
let testTenantId: string;

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCErrorEnvelope {
  error: { data: { code: string } };
}
interface TRPCSuccessEnvelope<T> {
  result: { data: T };
}
function isError<T>(env: TRPCSuccessEnvelope<T> | TRPCErrorEnvelope): env is TRPCErrorEnvelope {
  return "error" in env;
}

async function trpcQuery<O>(
  name: string,
  input: unknown,
  opts: { jwt?: string } = {},
): Promise<TRPCSuccessEnvelope<O> | TRPCErrorEnvelope> {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : undefined,
  });
  return (await res.json()) as TRPCSuccessEnvelope<O> | TRPCErrorEnvelope;
}

/** Poll pii_access_log (fire-and-forget writes settle asynchronously). */
async function pollPiiRows(
  where: { tenantId: string; entityId?: string; entityType?: string },
  opts: { minRows?: number; timeoutMs?: number } = {},
): Promise<PiiAccessLog[]> {
  const minRows = opts.minRows ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  let rows: PiiAccessLog[] = [];
  while (Date.now() < deadline) {
    rows = await db
      .select()
      .from(piiAccessLog)
      .where(
        and(
          eq(piiAccessLog.tenantId, where.tenantId),
          ...(where.entityId ? [eq(piiAccessLog.entityId, where.entityId)] : []),
          ...(where.entityType ? [eq(piiAccessLog.entityType, where.entityType)] : []),
        ),
      );
    if (rows.length >= minRows) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return rows;
}

describe("PII-01 pii_access_log", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    decodedClaims = decodeJwt(jwt) as JwtClaims;
    testUserId = decodedClaims.sub!;
    testTenantId = decodedClaims.tid!;

    // Clean any residue from a prior aborted run.
    await poolSql`DELETE FROM public.pii_access_log WHERE entity_id = ${CAND_PII_UUID}`;
    await poolSql`DELETE FROM public.candidates WHERE id = ${CAND_PII_UUID}`;
    await poolSql`DELETE FROM public.pii_access_log WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    await poolSql`DELETE FROM public.tenant_encryption_keys WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${PII_SYNTH_TENANT}`;

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${PII_SYNTH_TENANT}, 'synth-pii01', 'PII-01 Synth', 'ap-northeast-1', 'active')
    `;
  });

  afterAll(async () => {
    await poolSql`DELETE FROM public.pii_access_log WHERE entity_id = ${CAND_PII_UUID}`;
    await poolSql`DELETE FROM public.candidates WHERE id = ${CAND_PII_UUID}`;
    await poolSql`DELETE FROM public.pii_access_log WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    await poolSql`DELETE FROM public.tenant_encryption_keys WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${PII_SYNTH_TENANT}`;
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: getCandidateById records exactly one pii_access_log row with the right shape", async () => {
    // Seed a person + candidate in the caller's own tenant so RLS lets the
    // protected read through.
    const [personRow] = await poolSql<{ id: string }[]>`
      INSERT INTO public.persons (tenant_id, full_name, email_primary, email_normalised, phone_primary, location_country)
      VALUES (${testTenantId}, 'PII Test Person', 'pii-test@example.com', 'pii-test@example.com', '+919999999999', 'IN')
      RETURNING id
    `;
    const personId = personRow!.id;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CAND_PII_UUID}, ${testTenantId}, ${personId}, 'career_site', 'v1')
    `;
    await poolSql`DELETE FROM public.pii_access_log WHERE entity_id = ${CAND_PII_UUID}`;
    try {
      const env = await trpcQuery<unknown>("getCandidateById", { id: CAND_PII_UUID }, { jwt });
      assert.ok(!isError(env), `getCandidateById should succeed: ${JSON.stringify(env)}`);

      const rows = await pollPiiRows({ tenantId: testTenantId, entityId: CAND_PII_UUID });
      assert.equal(rows.length, 1, `expected exactly one pii_access_log row, got ${rows.length}`);
      const row = rows[0]!;
      assert.equal(row.entityType, "candidate");
      assert.equal(row.entityId, CAND_PII_UUID);
      assert.equal(row.actorLabel, "user");
      assert.equal(row.actorUserId, testUserId, "actor_user_id is the human caller");
      assert.equal(row.reason, "get_candidate_by_id");
      assert.ok(row.requestId, "request_id is captured from ctx");
      assert.ok(
        Array.isArray(row.fieldsAccessed) &&
          row.fieldsAccessed.includes("persons.email_primary") &&
          row.fieldsAccessed.includes("persons.phone_primary"),
        `fields_accessed should enumerate PII columns, got ${JSON.stringify(row.fieldsAccessed)}`,
      );
    } finally {
      await poolSql`DELETE FROM public.pii_access_log WHERE entity_id = ${CAND_PII_UUID}`;
      await poolSql`DELETE FROM public.candidates WHERE id = ${CAND_PII_UUID}`;
      await poolSql`DELETE FROM public.persons WHERE id = ${personId}`;
    }
  });

  it("Test 2: pii_access_log is append-only under the authenticated role", async () => {
    const entityId = randomUUID();
    // Seed a row in the caller's tenant via the service-role pool.
    const [seed] = await poolSql<{ id: string }[]>`
      INSERT INTO public.pii_access_log
        (tenant_id, actor_label, entity_type, entity_id, reason)
      VALUES (${testTenantId}, 'user', 'candidate', ${entityId}, 'append_only_probe')
      RETURNING id
    `;
    const rowId = seed!.id;
    try {
      const updated = await withTenantContext(decodedClaims, async ({ db: tdb }) => {
        return tdb
          .update(piiAccessLog)
          .set({ reason: "tampered" })
          .where(eq(piiAccessLog.id, rowId))
          .returning();
      });
      assert.equal(updated.length, 0, "UPDATE blocked by RLS (no UPDATE policy)");

      const deleted = await withTenantContext(decodedClaims, async ({ db: tdb }) => {
        return tdb.delete(piiAccessLog).where(eq(piiAccessLog.id, rowId)).returning();
      });
      assert.equal(deleted.length, 0, "DELETE blocked by RLS (no DELETE policy)");

      const [still] = await poolSql<{ reason: string }[]>`
        SELECT reason FROM public.pii_access_log WHERE id = ${rowId}
      `;
      assert.ok(still, "row still present after blocked UPDATE/DELETE");
      assert.equal(still.reason, "append_only_probe", "reason unchanged");
    } finally {
      await poolSql`DELETE FROM public.pii_access_log WHERE id = ${rowId}`;
    }
  });

  it("Test 3: tenant isolation on SELECT — caller sees only its own tenant's rows", async () => {
    const ownEntity = randomUUID();
    const synthEntity = randomUUID();
    await poolSql`
      INSERT INTO public.pii_access_log (tenant_id, actor_label, entity_type, entity_id, reason)
      VALUES
        (${testTenantId}, 'user', 'candidate', ${ownEntity}, 'isolation_probe'),
        (${PII_SYNTH_TENANT}, 'user', 'candidate', ${synthEntity}, 'isolation_probe')
    `;
    try {
      const visible = await withTenantContext(decodedClaims, async ({ db: tdb }) => {
        return tdb.select().from(piiAccessLog).where(eq(piiAccessLog.reason, "isolation_probe"));
      });
      assert.ok(
        visible.some((r) => r.entityId === ownEntity),
        "own-tenant row is visible",
      );
      assert.equal(
        visible.filter((r) => r.tenantId === PII_SYNTH_TENANT).length,
        0,
        "synth-tenant rows are hidden by RLS",
      );
    } finally {
      await poolSql`DELETE FROM public.pii_access_log WHERE entity_id IN (${ownEntity}, ${synthEntity})`;
    }
  });

  it("Test 4: getIntegrationCredential records supplied label, and defaults when omitted", async () => {
    await storeIntegrationCredential({
      tenantId: PII_SYNTH_TENANT,
      integrationType: "workday",
      secret: "pii01-credential-secret",
      metadata: { tenant_url: "https://wd.example.com" },
    });
    const [credRow] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.integration_credentials
      WHERE tenant_id = ${PII_SYNTH_TENANT} AND integration_type = 'workday'
    `;
    const credId = credRow!.id;
    await poolSql`DELETE FROM public.pii_access_log WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    try {
      // Caller-supplied context.
      const got = await getIntegrationCredential(
        { tenantId: PII_SYNTH_TENANT, integrationType: "workday" },
        { actorLabel: "workday-sync-worker", reason: "test.credential_read" },
      );
      assert.ok(got, "credential read succeeds");

      // Omitted context → default label / reason.
      const got2 = await getIntegrationCredential({
        tenantId: PII_SYNTH_TENANT,
        integrationType: "workday",
      });
      assert.ok(got2, "second credential read succeeds");

      const rows = await pollPiiRows(
        { tenantId: PII_SYNTH_TENANT, entityType: "integration_credential" },
        { minRows: 2 },
      );
      assert.ok(rows.length >= 2, `expected >= 2 credential-read rows, got ${rows.length}`);
      for (const r of rows) {
        assert.equal(r.entityId, credId, "entity_id is the credential row id");
      }
      const supplied = rows.find((r) => r.actorLabel === "workday-sync-worker");
      assert.ok(supplied, "supplied-context row recorded with caller label");
      assert.equal(supplied.reason, "test.credential_read");

      const defaulted = rows.find((r) => r.actorLabel === "service_role");
      assert.ok(defaulted, "omitted-context row recorded with default label");
      assert.equal(defaulted.reason, "unspecified");
    } finally {
      await poolSql`DELETE FROM public.pii_access_log WHERE tenant_id = ${PII_SYNTH_TENANT}`;
      await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${PII_SYNTH_TENANT}`;
    }
  });
});
