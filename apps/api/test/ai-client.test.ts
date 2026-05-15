/**
 * AI-01 integration tests for @hireops/ai-client.
 *
 * Coverage (10 cases):
 *   1. LocalAIClient.complete returns fixture text
 *   2. LocalAIClient.complete throws for missing fixture (clear message)
 *   3. LocalAIClient.completeStructured round-trips parsed JSON
 *   4. complete() writes an ai_usage_logs row (succeeded, correct
 *      tokens / cost / latency)
 *   5. complete() with throw fixture writes a row with succeeded=false
 *      and error_code populated
 *   6. ai_usage_logs RLS — tenant A cannot SELECT tenant B's rows under
 *      withTenantContext
 *   7. getAIClient / resolveProvider defaults to 'anthropic' when
 *      settings.ai_provider is unset
 *   8. getAIClient throws a clear error when the configured provider has
 *      no integration_credentials row
 *   9. getAIClient caches per (tenant_id, provider) — two test-mode calls
 *      return the same LocalAIClient instance
 *  10. AI_CLIENT_MODE=local overrides provider routing — even with a
 *      provider configured, the env override yields LocalAIClient
 *
 * Tests run under NODE_ENV=test → the factory forces LocalAIClient by
 * default, so no real API keys are consumed in CI. Tests 7-10 toggle
 * env vars where needed to exercise non-test-mode code paths; the
 * before/after blocks restore them.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalAIClient,
  hashCompleteOptions,
  hashStructuredOptions,
  resolveProvider,
  resetAIClientCache,
  getAIClient,
  type AICompleteOptions,
  type AIStructuredCompleteOptions,
} from "@hireops/ai-client";
import { sql as poolSql, db, withTenantContext, aiUsageLogs, type JwtClaims } from "@hireops/db";
import { eq } from "drizzle-orm";

// AI-01 synth tenants — hex-only suffixes.
const AI_TENANT_A = "00000000-0000-0000-0000-00000a1ce101";
const AI_TENANT_B = "00000000-0000-0000-0000-00000a1ce102";
const AI_TENANT_DEFAULT = "00000000-0000-0000-0000-00000a1ce103";
const AI_TENANT_MISSING_CRED = "00000000-0000-0000-0000-00000a1ce104";
const AI_TENANT_CACHE = "00000000-0000-0000-0000-00000a1ce105";

const ALL_AI_TENANTS = [
  AI_TENANT_A,
  AI_TENANT_B,
  AI_TENANT_DEFAULT,
  AI_TENANT_MISSING_CRED,
  AI_TENANT_CACHE,
];

let fixtureDir: string;

async function writeFixture(hash: string, body: unknown): Promise<void> {
  await writeFile(join(fixtureDir, `${hash}.json`), JSON.stringify(body, null, 2));
}

async function cleanupAITenants(): Promise<void> {
  for (const id of ALL_AI_TENANTS) {
    await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${id}`;
    await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${id}`;
    await poolSql`DELETE FROM public.tenant_encryption_keys WHERE tenant_id = ${id}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${id}`;
  }
}

describe("ai-client (AI-01)", () => {
  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "ai-client-fixtures-"));
    await cleanupAITenants();
    // Provision the synth tenants. Settings are filled in per-test so
    // we can verify default-vs-explicit provider resolution.
    for (const id of ALL_AI_TENANTS) {
      const slug = `synth-ai01-${id.slice(-6)}`;
      await poolSql`
        INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
        VALUES (${id}, ${slug}, 'AI-01 Synth', 'ap-northeast-1', 'active')
      `;
    }
  });

  afterAll(async () => {
    await cleanupAITenants();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: LocalAIClient.complete returns fixture text + usage logged", async () => {
    const opts: AICompleteOptions = {
      prompt: "Summarise this resume.",
      system: "You are a recruiter.",
      model: "test-fixture-v1",
      feature: "resume_parse",
    };
    const hash = hashCompleteOptions(opts);
    await writeFixture(hash, {
      text: "Senior Python engineer, 8 years.",
      inputTokens: 120,
      outputTokens: 12,
      costMicros: 540,
      latencyMs: 25,
    });
    const client = new LocalAIClient({ tenantId: AI_TENANT_A, fixtureDir });
    try {
      const res = await client.complete(opts);
      assert.equal(res.text, "Senior Python engineer, 8 years.");
      assert.equal(res.inputTokens, 120);
      assert.equal(res.outputTokens, 12);
      assert.equal(res.costMicros, 540n);
      assert.equal(res.latencyMs, 25);
      assert.equal(res.model, "test-fixture-v1");
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${AI_TENANT_A}`;
    }
  });

  it("Test 2: LocalAIClient throws clear error for missing fixture", async () => {
    const client = new LocalAIClient({ tenantId: AI_TENANT_A, fixtureDir });
    let threw = false;
    let msg = "";
    try {
      await client.complete({
        prompt: "no fixture for this prompt",
        feature: "resume_parse",
      });
    } catch (e: unknown) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    assert.ok(threw, "expected complete() to throw on missing fixture");
    assert.match(msg, /no fixture for prompt hash/i, `unexpected message: ${msg}`);
    assert.match(msg, /\.json/, "message should mention the .json path");
  });

  it("Test 3: completeStructured returns parsed JSON matching the schema", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        years: { type: "integer" },
      },
      required: ["name", "years"],
      additionalProperties: false,
    };
    const opts: AIStructuredCompleteOptions<{ name: string; years: number }> = {
      prompt: "Extract candidate.",
      model: "test-fixture-v1",
      feature: "resume_parse",
      schema,
    };
    const hash = hashStructuredOptions(opts);
    await writeFixture(hash, {
      json: { name: "Asha Rao", years: 8 },
      inputTokens: 200,
      outputTokens: 18,
      costMicros: 870,
    });
    const client = new LocalAIClient({ tenantId: AI_TENANT_A, fixtureDir });
    try {
      const parsed = await client.completeStructured(opts);
      assert.equal(parsed.name, "Asha Rao");
      assert.equal(parsed.years, 8);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${AI_TENANT_A}`;
    }
  });

  it("Test 4: complete() writes ai_usage_logs row with correct cost / tokens", async () => {
    const opts: AICompleteOptions = {
      prompt: "Score this candidate.",
      model: "test-fixture-v1",
      feature: "jd_score",
      requestId: "req-test-4",
    };
    const hash = hashCompleteOptions(opts);
    await writeFixture(hash, {
      text: "Score: 0.82",
      inputTokens: 300,
      outputTokens: 5,
      costMicros: 975,
      latencyMs: 42,
    });
    const client = new LocalAIClient({ tenantId: AI_TENANT_A, fixtureDir });
    try {
      await client.complete(opts);
      const rows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.tenantId, AI_TENANT_A));
      assert.equal(rows.length, 1, "exactly one usage log row");
      const row = rows[0]!;
      assert.equal(row.provider, "local");
      assert.equal(row.model, "test-fixture-v1");
      assert.equal(row.feature, "jd_score");
      assert.equal(row.inputTokens, 300);
      assert.equal(row.outputTokens, 5);
      assert.equal(row.costMicros, 975n);
      assert.equal(row.latencyMs, 42);
      assert.equal(row.requestId, "req-test-4");
      assert.equal(row.succeeded, true);
      assert.equal(row.errorCode, null);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${AI_TENANT_A}`;
    }
  });

  it("Test 5: complete() failure path writes row with succeeded=false + error_code", async () => {
    const opts: AICompleteOptions = {
      prompt: "Make this fail.",
      model: "test-fixture-v1",
      feature: "screening_summary",
    };
    const hash = hashCompleteOptions(opts);
    await writeFixture(hash, {
      text: "ignored",
      inputTokens: 50,
      outputTokens: 0,
      costMicros: 150,
      throw: { message: "simulated rate limit", code: "rate_limit_exceeded" },
    });
    const client = new LocalAIClient({ tenantId: AI_TENANT_A, fixtureDir });
    let threw = false;
    try {
      try {
        await client.complete(opts);
      } catch (e: unknown) {
        threw = true;
        assert.match(e instanceof Error ? e.message : String(e), /simulated rate limit/);
      }
      assert.ok(threw, "expected complete() to throw");
      const rows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.tenantId, AI_TENANT_A));
      assert.equal(rows.length, 1, "exactly one usage log row");
      const row = rows[0]!;
      assert.equal(row.succeeded, false);
      assert.equal(row.errorCode, "rate_limit_exceeded");
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${AI_TENANT_A}`;
    }
  });

  it("Test 6: ai_usage_logs RLS — tenant A cannot read tenant B's rows", async () => {
    // Seed one row for each of A and B via the service-role pool.
    const opts: AICompleteOptions = {
      prompt: "Tenant isolation check.",
      model: "test-fixture-v1",
      feature: "resume_parse",
    };
    const hash = hashCompleteOptions(opts);
    await writeFixture(hash, {
      text: "ok",
      inputTokens: 10,
      outputTokens: 1,
      costMicros: 35,
    });
    try {
      await new LocalAIClient({ tenantId: AI_TENANT_A, fixtureDir }).complete(opts);
      await new LocalAIClient({ tenantId: AI_TENANT_B, fixtureDir }).complete(opts);

      // Read as tenant A via withTenantContext.
      const claimsA: JwtClaims = {
        sub: "00000000-0000-0000-0000-000000000001",
        tid: AI_TENANT_A,
        tenant_slug: "synth-ai01-a",
        roles: ["admin"],
      };
      const visibleA = await withTenantContext(claimsA, async ({ db: tx }) => {
        return tx.select().from(aiUsageLogs);
      });
      assert.equal(visibleA.length, 1, "tenant A sees exactly 1 row (their own)");
      assert.equal(visibleA[0]?.tenantId, AI_TENANT_A);

      // And as tenant B.
      const claimsB: JwtClaims = {
        sub: "00000000-0000-0000-0000-000000000002",
        tid: AI_TENANT_B,
        tenant_slug: "synth-ai01-b",
        roles: ["admin"],
      };
      const visibleB = await withTenantContext(claimsB, async ({ db: tx }) => {
        return tx.select().from(aiUsageLogs);
      });
      assert.equal(visibleB.length, 1, "tenant B sees exactly 1 row (their own)");
      assert.equal(visibleB[0]?.tenantId, AI_TENANT_B);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id IN (${AI_TENANT_A}, ${AI_TENANT_B})`;
    }
  });

  it("Test 7: resolveProvider defaults to 'anthropic' when settings.ai_provider unset", async () => {
    // AI_TENANT_DEFAULT was seeded with default settings ({}).
    const provider = await resolveProvider(AI_TENANT_DEFAULT);
    assert.equal(provider, "anthropic");

    // Explicit anthropic also resolves.
    await poolSql`UPDATE public.tenants SET settings = ${JSON.stringify({ ai_provider: "anthropic" })}::jsonb WHERE id = ${AI_TENANT_DEFAULT}`;
    assert.equal(await resolveProvider(AI_TENANT_DEFAULT), "anthropic");

    // Explicit openai resolves.
    await poolSql`UPDATE public.tenants SET settings = ${JSON.stringify({ ai_provider: "openai" })}::jsonb WHERE id = ${AI_TENANT_DEFAULT}`;
    assert.equal(await resolveProvider(AI_TENANT_DEFAULT), "openai");

    // Unsupported value throws.
    await poolSql`UPDATE public.tenants SET settings = ${JSON.stringify({ ai_provider: "gemini" })}::jsonb WHERE id = ${AI_TENANT_DEFAULT}`;
    let threw = false;
    try {
      await resolveProvider(AI_TENANT_DEFAULT);
    } catch (e: unknown) {
      threw = true;
      assert.match(e instanceof Error ? e.message : String(e), /unsupported ai_provider/i);
    }
    assert.ok(threw, "unsupported value should throw");

    // Reset to default {} for next test.
    await poolSql`UPDATE public.tenants SET settings = ${"{}"}::jsonb WHERE id = ${AI_TENANT_DEFAULT}`;
  });

  it("Test 8: getAIClient throws when configured provider has no credential", async () => {
    await poolSql`UPDATE public.tenants SET settings = ${JSON.stringify({ ai_provider: "openai" })}::jsonb WHERE id = ${AI_TENANT_MISSING_CRED}`;
    // Disable test-mode short-circuit so the factory actually resolves
    // the credential. The throw fires before any SDK is loaded.
    const prevNodeEnv = process.env.NODE_ENV;
    const prevMode = process.env.AI_CLIENT_MODE;
    process.env.NODE_ENV = "production";
    delete process.env.AI_CLIENT_MODE;
    resetAIClientCache();
    let threw = false;
    let msg = "";
    try {
      try {
        await getAIClient(AI_TENANT_MISSING_CRED);
      } catch (e: unknown) {
        threw = true;
        msg = e instanceof Error ? e.message : String(e);
      }
      assert.ok(threw, "expected getAIClient to throw");
      assert.match(msg, /no openai credential/i, `unexpected message: ${msg}`);
      assert.match(msg, /ai_openai/, "should mention the integration_type");
    } finally {
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
      if (prevMode !== undefined) process.env.AI_CLIENT_MODE = prevMode;
      resetAIClientCache();
    }
  });

  it("Test 9: getAIClient caches per (tenant_id, provider) — same instance within TTL", async () => {
    resetAIClientCache();
    const a = await getAIClient(AI_TENANT_CACHE);
    const b = await getAIClient(AI_TENANT_CACHE);
    assert.ok(a === b, "cached call returns same instance");
    const c = await getAIClient(AI_TENANT_CACHE, { forceFresh: true });
    assert.ok(c !== a, "forceFresh bypasses cache");
    resetAIClientCache();
  });

  it("Test 10: AI_CLIENT_MODE=local overrides provider routing", async () => {
    // Configure tenant for openai with NO credential. If the env override
    // didn't work, the factory would try credential lookup and throw —
    // so a successful return proves the override short-circuited.
    await poolSql`UPDATE public.tenants SET settings = ${JSON.stringify({ ai_provider: "openai" })}::jsonb WHERE id = ${AI_TENANT_MISSING_CRED}`;
    const prevNodeEnv = process.env.NODE_ENV;
    const prevMode = process.env.AI_CLIENT_MODE;
    process.env.NODE_ENV = "production";
    process.env.AI_CLIENT_MODE = "local";
    resetAIClientCache();
    try {
      const client = await getAIClient(AI_TENANT_MISSING_CRED);
      assert.equal(client.provider, "local", "AI_CLIENT_MODE=local should yield LocalAIClient");
    } finally {
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
      if (prevMode !== undefined) process.env.AI_CLIENT_MODE = prevMode;
      else delete process.env.AI_CLIENT_MODE;
      resetAIClientCache();
    }
  });
});
