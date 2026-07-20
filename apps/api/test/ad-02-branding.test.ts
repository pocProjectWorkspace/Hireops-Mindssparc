/**
 * AD-02 — tenant theme & branding: the real rebrand feature.
 *
 * Coverage:
 *   Test 1: resolveBrandingSettings merge/defaults — empty, partial and
 *           malformed stored blocks all resolve to a complete, valid block.
 *   Test 2: getTenantBranding (admin) returns the tenant's display_name COLUMN
 *           plus default cosmetics when no branding block is stored.
 *   Test 3: admin-only gating — recruiter is FORBIDDEN from read AND write.
 *   Test 4: updateTenantBranding writes the display_name COLUMN + the
 *           settings.branding jsonb, PRESERVES unrelated settings keys, and
 *           writes an api_audit_logs row.
 *   Test 5: update validation — a non-hex colour and an empty company name are
 *           rejected; a blank logo URL is accepted as null.
 *
 * NODE_ENV=test. Requires `pnpm db:seed:test-users` (admin1 / recruiter1).
 * kyndryl-poc's display_name + settings jsonb are snapshotted in beforeAll and
 * restored VERBATIM in afterAll — this test writes the tenant's real name.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  resolveBrandingSettings,
  defaultBrandingSettings,
  BRANDING_DEFAULT_PRIMARY_COLOR,
  type GetTenantBrandingOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

let adminJwt: string;
let recruiterJwt: string;
let tenantId: string;
let originalDisplayName: string;
let originalSettings: unknown;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
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
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
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

describe("AD-02 — tenant theme & branding", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    const [t] = await poolSql<{ id: string; display_name: string; settings: unknown }[]>`
      SELECT id, display_name, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalDisplayName = t.display_name;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip any branding block a previous run left behind.
    await poolSql`
      UPDATE public.tenants SET settings = settings - 'branding' WHERE id = ${tenantId}
    `;
  });

  afterAll(async () => {
    // Restore the tenant's real name + settings exactly as found.
    try {
      await poolSql`
        UPDATE public.tenants
        SET display_name = ${originalDisplayName},
            settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${tenantId}
      `;
    } catch {
      // best-effort
    }
  });

  it("Test 1: resolveBrandingSettings merges defaults over empty / partial / malformed blocks", () => {
    const defaults = defaultBrandingSettings();
    assert.equal(defaults.primaryColor, BRANDING_DEFAULT_PRIMARY_COLOR);
    assert.equal(defaults.logoUrl, null);
    assert.equal(defaults.darkModeDefault, false);

    // Absent block → defaults.
    assert.deepEqual(resolveBrandingSettings(undefined), defaults);
    assert.deepEqual(resolveBrandingSettings({}), defaults);

    // Partial block → merged (unset fields default).
    const partial = resolveBrandingSettings({ primaryColor: "#123456" });
    assert.equal(partial.primaryColor, "#123456");
    assert.equal(partial.logoUrl, null, "unset fields default");
    assert.equal(partial.darkModeDefault, false);

    // Malformed block → defaults, never a throw.
    assert.deepEqual(resolveBrandingSettings({ primaryColor: "not-a-colour" }), defaults);
    assert.deepEqual(resolveBrandingSettings("garbage"), defaults);
  });

  it("Test 2: getTenantBranding returns the display_name column + default cosmetics", async () => {
    const res = await trpcQuery<GetTenantBrandingOutput>("getTenantBranding", {}, adminJwt);
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.displayName, originalDisplayName, "reads the real column");
    assert.equal(res.result.data.primaryColor, BRANDING_DEFAULT_PRIMARY_COLOR);
    assert.equal(res.result.data.logoUrl, null);
    assert.equal(res.result.data.darkModeDefault, false);
  });

  it("Test 3: recruiter is FORBIDDEN from read and write", async () => {
    const read = await trpcQuery("getTenantBranding", {}, recruiterJwt);
    assert.ok(isErr(read) && read.error.data.code === "FORBIDDEN", "read forbidden");
    const write = await trpcMutation(
      "updateTenantBranding",
      {
        displayName: "Hacker Corp",
        primaryColor: "#ff0000",
        logoUrl: null,
        darkModeDefault: false,
      },
      recruiterJwt,
    );
    assert.ok(isErr(write) && write.error.data.code === "FORBIDDEN", "write forbidden");
    // The column was NOT changed by the forbidden write.
    const [row] = await poolSql<{ display_name: string }[]>`
      SELECT display_name FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.equal(
      row!.display_name,
      originalDisplayName,
      "display name untouched by forbidden write",
    );
  });

  it("Test 4: update writes the column + branding jsonb, preserves siblings, and audits", async () => {
    // Plant an unrelated sibling key to prove the merge doesn't clobber.
    await poolSql`
      UPDATE public.tenants
      SET settings = settings || ${JSON.stringify({ ad02_sentinel: "keep-me" })}::jsonb
      WHERE id = ${tenantId}
    `;

    const res = await trpcMutation<{ ok: true; branding: GetTenantBrandingOutput }>(
      "updateTenantBranding",
      {
        displayName: "NovaChem GCC",
        primaryColor: "#14B8A6",
        logoUrl: "https://cdn.example.test/novachem.png",
        darkModeDefault: true,
      },
      adminJwt,
    );
    assert.ok(!isErr(res), `expected success, got ${JSON.stringify(res)}`);
    assert.equal(res.result.data.branding.displayName, "NovaChem GCC");
    assert.equal(res.result.data.branding.primaryColor, "#14B8A6");
    assert.equal(res.result.data.branding.logoUrl, "https://cdn.example.test/novachem.png");
    assert.equal(res.result.data.branding.darkModeDefault, true);

    // The display_name COLUMN changed — this is the actual rebrand.
    const [row] = await poolSql<{ display_name: string; settings: Record<string, unknown> }[]>`
      SELECT display_name, settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.equal(row!.display_name, "NovaChem GCC", "display_name COLUMN rewritten");
    assert.equal(row!.settings["ad02_sentinel"], "keep-me", "sibling key preserved");
    const stored = row!.settings["branding"] as Record<string, unknown>;
    assert.ok(stored, "branding block stored");
    assert.equal(stored["primaryColor"], "#14B8A6");
    assert.equal(stored["darkModeDefault"], true);

    // The effective read reflects the write.
    const readBack = await trpcQuery<GetTenantBrandingOutput>("getTenantBranding", {}, adminJwt);
    assert.ok(!isErr(readBack));
    assert.equal(readBack.result.data.displayName, "NovaChem GCC");
    assert.equal(readBack.result.data.primaryColor, "#14B8A6");

    // withAudit is fire-and-forget — poll briefly for the audit row.
    let audited = false;
    for (let i = 0; i < 15 && !audited; i++) {
      const [a] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId}
          AND action = 'update_tenant_branding'
          AND created_at >= now() - interval '2 minutes'
      `;
      audited = Number(a?.n) >= 1;
      if (!audited) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(audited, "an update_tenant_branding api_audit_logs row exists");

    // Remove the sentinel again (settings restored fully in afterAll anyway).
    await poolSql`
      UPDATE public.tenants SET settings = settings - 'ad02_sentinel' WHERE id = ${tenantId}
    `;
  });

  it("Test 5: update rejects bad colour + empty name; accepts a blank logo as null", async () => {
    const badColor = await trpcMutation(
      "updateTenantBranding",
      { displayName: "Fine Name", primaryColor: "teal", logoUrl: null, darkModeDefault: false },
      adminJwt,
    );
    assert.ok(isErr(badColor), "non-hex colour rejected");

    const emptyName = await trpcMutation(
      "updateTenantBranding",
      { displayName: "   ", primaryColor: "#123456", logoUrl: null, darkModeDefault: false },
      adminJwt,
    );
    assert.ok(isErr(emptyName), "empty company name rejected");

    // A blank logo URL is coerced to null (cleared logo), not a validation error.
    const blankLogo = await trpcMutation<{ ok: true; branding: GetTenantBrandingOutput }>(
      "updateTenantBranding",
      {
        displayName: originalDisplayName,
        primaryColor: "#123456",
        logoUrl: "",
        darkModeDefault: false,
      },
      adminJwt,
    );
    assert.ok(!isErr(blankLogo), `blank logo should be accepted, got ${JSON.stringify(blankLogo)}`);
    assert.equal(blankLogo.result.data.branding.logoUrl, null, "blank logo → null");
  });
});
