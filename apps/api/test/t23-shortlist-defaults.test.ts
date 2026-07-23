/**
 * T2.3 / G08 — shortlist threshold + tier defaults (tenants.settings.shortlistDefaults).
 *
 * Honesty focus: the per-tenant shortlist defaults (threshold + tier cutoffs)
 * are genuinely PERSISTED and CONSUMED — the saved default actually DRIVES the
 * listShortlist computation, not merely the UI. Exercised over real cloud-minted
 * JWTs (reality #110 — sign in as the seeded personas):
 *
 *   Test 1: updateShortlistDefaults (admin) persists a full custom block →
 *           getShortlistDefaults (admin + recruiter) returns it verbatim.
 *   Test 2: merge-over-defaults — an UNCONFIGURED tenant (key stripped) resolves
 *           to the code defaults 75 / 90 / 75 / 60 (byte-identical to the
 *           MATCH_TIER_*_MIN constants + the historic listShortlist threshold).
 *   Test 3: listShortlist honours the tenant threshold + cutoffs when the input
 *           omits `threshold`; an explicit input threshold still overrides.
 *   Test 4: tier bucketing shifts when cutoffs are configured — a score that is
 *           "good" at the 75 floor becomes "excellent" once the excellent floor
 *           is lowered (pure matchTier), and listShortlist echoes the configured
 *           cutoffs end-to-end.
 *   Test 5: write gating — recruiter is FORBIDDEN on updateShortlistDefaults;
 *           a cross-field-invalid block (partial > good) is rejected.
 *   Test 6: tenant isolation — the atomic settings merge only touches the acting
 *           tenant; a synthetic sibling tenant's settings are untouched.
 *
 * kyndryl-poc's settings jsonb is snapshotted in beforeAll and restored verbatim
 * in afterAll, so the demo config is never clobbered. Requires
 * `pnpm db:seed:test-users` (admin1 / recruiter1).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import {
  matchTier,
  MATCH_TIER_EXCELLENT_MIN,
  MATCH_TIER_GOOD_MIN,
  MATCH_TIER_PARTIAL_MIN,
} from "../src/lib/recruiter-urgency";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const SYNTH_TENANT = randomUUID();
const SYNTH_SLUG = "t23-synth-shortlist";

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

interface TierCutoffs {
  excellent: number;
  good: number;
  partial: number;
}
interface ShortlistDefaults {
  version: number;
  threshold: number;
  tierCutoffs: TierCutoffs;
}
interface ListShortlistOut {
  threshold: number;
  tierCutoffs: TierCutoffs;
  tierCounts: { excellent: number; good: number; partial: number };
  rows: unknown[];
}

let recruiterJwt: string;
let adminJwt: string;
let tenantId: string;
let originalSettings: unknown = {};

async function stripShortlistDefaults() {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'shortlistDefaults' WHERE id = ${tenantId}
  `;
}

describe("T2.3 / G08 — shortlist threshold + tier defaults", () => {
  beforeAll(async () => {
    [adminJwt, recruiterJwt] = await Promise.all([signIn(ADMIN), signIn(RECRUITER)]);
    const [t] = await poolSql<{ id: string; settings: unknown }[]>`
      SELECT id, settings FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    originalSettings = t.settings ?? {};
    // Deterministic start: strip any shortlistDefaults a prior run / live check
    // left behind. afterAll restores the snapshot verbatim.
    await stripShortlistDefaults();

    // Synthetic sibling tenant for the isolation test, carrying a sentinel
    // settings key that must survive our tenant's update untouched.
    await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT}`;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status, settings)
      VALUES (${SYNTH_TENANT}, ${SYNTH_SLUG}, 'T2.3 Synth', 'ap-northeast-1', 'active',
              ${JSON.stringify({ t23_sentinel: "keep-me" })}::jsonb)
    `;
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
    try {
      await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT}`;
    } catch {
      // best-effort cleanup
    }
  });

  it("Test 1: admin update persists a custom block; get (admin + recruiter) returns it verbatim", async () => {
    const block = {
      version: 1,
      threshold: 82,
      tierCutoffs: { excellent: 88, good: 70, partial: 55 },
    };
    const up = await trpcMutation<{ ok: true; shortlistDefaults: ShortlistDefaults }>(
      "updateShortlistDefaults",
      block,
      adminJwt,
    );
    assert.ok(!isErr(up), `updateShortlistDefaults (admin): ${JSON.stringify(up)}`);
    assert.equal(up.result.data.ok, true);
    assert.deepEqual(up.result.data.shortlistDefaults, block, "returned block echoes the input");

    const getAdmin = await trpcQuery<ShortlistDefaults>("getShortlistDefaults", {}, adminJwt);
    assert.ok(!isErr(getAdmin), `getShortlistDefaults (admin): ${JSON.stringify(getAdmin)}`);
    assert.deepEqual(getAdmin.result.data, block, "get (admin) reflects the persisted block");

    // Recruiter can READ the defaults (recruiter surface seeds from them).
    const getRec = await trpcQuery<ShortlistDefaults>("getShortlistDefaults", {}, recruiterJwt);
    assert.ok(!isErr(getRec), `getShortlistDefaults (recruiter): ${JSON.stringify(getRec)}`);
    assert.deepEqual(getRec.result.data, block, "get (recruiter) reflects the persisted block");

    // Genuinely persisted in the DB jsonb, not just echoed.
    const [row] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId}
    `;
    assert.deepEqual(
      row!.settings["shortlistDefaults"],
      block,
      "persisted to tenants.settings jsonb",
    );
  });

  it("Test 2: an unconfigured tenant resolves to code defaults 75 / 90 / 75 / 60", async () => {
    await stripShortlistDefaults();
    const get = await trpcQuery<ShortlistDefaults>("getShortlistDefaults", {}, adminJwt);
    assert.ok(!isErr(get), `getShortlistDefaults: ${JSON.stringify(get)}`);
    assert.deepEqual(
      get.result.data,
      {
        version: 1,
        threshold: 75,
        tierCutoffs: {
          excellent: MATCH_TIER_EXCELLENT_MIN,
          good: MATCH_TIER_GOOD_MIN,
          partial: MATCH_TIER_PARTIAL_MIN,
        },
      },
      "resolve merges over defaults byte-identical to the constants",
    );
  });

  it("Test 3: listShortlist honours the tenant threshold when input omits it; explicit input overrides", async () => {
    const block = {
      version: 1,
      threshold: 82,
      tierCutoffs: { excellent: 88, good: 70, partial: 55 },
    };
    const up = await trpcMutation("updateShortlistDefaults", block, adminJwt);
    assert.ok(!isErr(up), `updateShortlistDefaults: ${JSON.stringify(up)}`);

    // No threshold in input → falls back to the tenant default (82) + cutoffs.
    const seeded = await trpcQuery<ListShortlistOut>("listShortlist", {}, recruiterJwt);
    assert.ok(!isErr(seeded), `listShortlist({}): ${JSON.stringify(seeded)}`);
    assert.equal(seeded.result.data.threshold, 82, "effective threshold = tenant default");
    assert.deepEqual(
      seeded.result.data.tierCutoffs,
      { excellent: 88, good: 70, partial: 55 },
      "output carries the resolved tenant cutoffs",
    );

    // Explicit input threshold still wins over the tenant default.
    const overridden = await trpcQuery<ListShortlistOut>(
      "listShortlist",
      { threshold: 50 },
      recruiterJwt,
    );
    assert.ok(!isErr(overridden), `listShortlist({threshold:50}): ${JSON.stringify(overridden)}`);
    assert.equal(
      overridden.result.data.threshold,
      50,
      "explicit input threshold overrides default",
    );
    assert.deepEqual(
      overridden.result.data.tierCutoffs,
      { excellent: 88, good: 70, partial: 55 },
      "cutoffs still resolved from the tenant even when threshold is overridden",
    );
  });

  it("Test 4: tier bucketing shifts when cutoffs are configured (good→excellent as excellent floor drops)", () => {
    // Pure engine: a score of 80 is "good" at the default 90 floor…
    assert.equal(matchTier(80), "good", "80 is good under the default 90 excellent floor");
    // …and becomes "excellent" once the excellent floor is lowered to 70.
    assert.equal(
      matchTier(80, { excellent: 70, good: 60, partial: 50 }),
      "excellent",
      "80 is excellent once the excellent floor drops to 70",
    );
    // Omitting cutoffs preserves the historic constants exactly.
    assert.equal(matchTier(MATCH_TIER_EXCELLENT_MIN), "excellent");
    assert.equal(matchTier(MATCH_TIER_GOOD_MIN - 1), "partial");
    assert.equal(matchTier(MATCH_TIER_PARTIAL_MIN - 1), "below");
    assert.equal(matchTier(null), null);
  });

  it("Test 5: recruiter is FORBIDDEN on update; a cross-field-invalid block is rejected", async () => {
    const denied = await trpcMutation(
      "updateShortlistDefaults",
      { version: 1, threshold: 75, tierCutoffs: { excellent: 90, good: 75, partial: 60 } },
      recruiterJwt,
    );
    assert.ok(
      isErr(denied) && denied.error.data.code === "FORBIDDEN",
      `recruiter FORBIDDEN on update: ${JSON.stringify(denied)}`,
    );

    // partial (80) > good (70) violates the ordering refine → rejected before the procedure runs.
    const bad = await trpcMutation(
      "updateShortlistDefaults",
      { version: 1, threshold: 75, tierCutoffs: { excellent: 90, good: 70, partial: 80 } },
      adminJwt,
    );
    assert.ok(isErr(bad), `invalid cross-field cutoffs rejected: ${JSON.stringify(bad)}`);
  });

  it("Test 6: tenant isolation — the settings merge only touches the acting tenant", async () => {
    const block = {
      version: 1,
      threshold: 77,
      tierCutoffs: { excellent: 92, good: 78, partial: 62 },
    };
    const up = await trpcMutation("updateShortlistDefaults", block, adminJwt);
    assert.ok(!isErr(up), `updateShortlistDefaults: ${JSON.stringify(up)}`);

    const [synth] = await poolSql<{ settings: Record<string, unknown> }[]>`
      SELECT settings FROM public.tenants WHERE id = ${SYNTH_TENANT}
    `;
    assert.equal(synth!.settings["t23_sentinel"], "keep-me", "sibling tenant sentinel preserved");
    assert.equal(
      synth!.settings["shortlistDefaults"],
      undefined,
      "sibling tenant did NOT receive the update",
    );
  });
});
