/**
 * AI-02 integration tests for the resume parser.
 *
 * Coverage (10 cases):
 *   1. parserOutputSchema accepts a fully-populated valid output
 *   2. parserOutputSchema rejects an invalid output (confidence_score > 1)
 *   3. parseResumeFromText returns the expected ParserOutput shape
 *   4. current_role mirroring — work_history[0].end_date null → current_role set
 *   5. Empty text → low-confidence empty output, no throw
 *   6. LLM error path (fixture.throw) → low-confidence empty output, no throw
 *   7. Invalid LLM JSON (fixture missing required fields) → low-confidence empty, no throw
 *   8. ai_usage_logs row written with feature='resume_parse'
 *   9. extractText rejects unsupported mime types with ExtractionError
 *  10. parseResume with unsupported mime type → graceful low-confidence empty
 *
 * Tests pass an explicit LocalAIClient (constructed with a tmpdir
 * fixtureDir) rather than rely on getAIClient resolution, so they don't
 * require the synth tenant to have a credential row.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalAIClient,
  hashStructuredOptions,
  parseResumeFromText,
  parseResume,
  parserOutputSchema,
  parserOutputJsonSchema,
  PARSER_VERSION,
  extractText,
  ExtractionError,
  type ParserOutput,
} from "@hireops/ai-client";
import { sql as poolSql, db, aiUsageLogs } from "@hireops/db";
import { eq } from "drizzle-orm";

const TENANT = "00000000-0000-0000-0000-00000a1ce201";

let fixtureDir: string;

const SYSTEM_PROMPT = `You are a recruitment data extraction system. \
You read a candidate resume in free-form text and produce a structured \
JSON object matching the provided schema exactly.

Rules you must follow:
1. Use null for any field you cannot extract with confidence. Do NOT guess.
2. Dates: ISO 8601, "YYYY-MM" if month is known, "YYYY" if only year.
3. Email: lowercase the primary email address.
4. Phone: prefer E.164 ("+91…") if a country code is present; otherwise \
return the digits as they appear in the resume.
5. Order work_history most-recent first. If the most recent role's \
end_date is null, set current_role to mirror it.
6. Compute total_years_experience by summing the spans in work_history \
(treating null end_date as today). Reconcile against any explicit "X years" \
claim — if they disagree by more than 1 year, trust the work_history sum.
7. employment_type is best-effort. Set null when not stated explicitly.
8. grade is free text ("8.2 CGPA", "First Class", "75%"). Do not normalise.
9. confidence_score in parse_metadata: 1.0 = every field extracted with \
certainty; 0.5 = significant gaps or ambiguity; 0.2 = most fields could \
not be confidently extracted. Honest self-reporting — low confidence is \
data-quality signal, not failure.

Return ONLY the JSON object matching the schema. No prose.`;

interface FixtureBody {
  json?: unknown;
  text?: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs?: number;
  throw?: { message: string; code?: string };
}

async function writeFixture(text: string, model: string, body: FixtureBody): Promise<void> {
  const hash = hashStructuredOptions({
    prompt: text,
    system: SYSTEM_PROMPT,
    model,
    feature: "resume_parse",
    schema: parserOutputJsonSchema,
    schemaName: "resume_parse",
    maxTokens: 4000,
  });
  await writeFile(join(fixtureDir, `${hash}.json`), JSON.stringify(body, null, 2));
}

function makeValidOutput(): ParserOutput {
  return {
    personal: {
      full_name: "Asha Rao",
      email: "asha.rao@example.com",
      phone: "+919876543210",
      location_city: "Bengaluru",
      location_country: "IN",
      linkedin_url: "https://linkedin.com/in/ashar",
      github_url: null,
      portfolio_url: null,
    },
    summary: "Senior Python engineer with 8 years of backend experience.",
    total_years_experience: 8,
    current_role: {
      title: "Senior Backend Engineer",
      company: "ExampleCo",
      start_date: "2022-06",
      location: "Bengaluru",
      description: "Leading the platform team.",
    },
    work_history: [
      {
        title: "Senior Backend Engineer",
        company: "ExampleCo",
        start_date: "2022-06",
        end_date: null,
        location: "Bengaluru",
        description: "Leading the platform team.",
        employment_type: "full_time",
      },
      {
        title: "Backend Engineer",
        company: "OtherCo",
        start_date: "2018-08",
        end_date: "2022-05",
        location: "Bengaluru",
        description: "Microservices in Python.",
        employment_type: "full_time",
      },
    ],
    education: [
      {
        degree: "B.Tech",
        field_of_study: "Computer Science",
        institution: "IIT Madras",
        start_year: 2014,
        end_year: 2018,
        grade: "8.2 CGPA",
      },
    ],
    skills: {
      technical: ["python", "django", "postgres"],
      languages: ["English", "Hindi"],
      certifications: [],
      domain: ["fintech"],
    },
    notice_period_days: 90,
    expected_compensation: { amount: 4500000, currency: "INR", period: "annual" },
    parse_metadata: {
      parser_version: PARSER_VERSION,
      parsed_at: "2026-05-16T00:00:00.000Z",
      confidence_score: 0.92,
      source_format: "pdf_text",
      parser_model: "test-model-v1",
    },
  };
}

describe("resume parser (AI-02)", () => {
  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "resume-parser-fixtures-"));
    await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${TENANT}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${TENANT}`;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${TENANT}, 'synth-ai02', 'AI-02 Synth', 'ap-northeast-1', 'active')
    `;
  });

  afterAll(async () => {
    await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${TENANT}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${TENANT}`;
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: parserOutputSchema accepts a fully-populated valid output", () => {
    const parsed = parserOutputSchema.parse(makeValidOutput());
    assert.equal(parsed.personal.full_name, "Asha Rao");
    assert.equal(parsed.work_history.length, 2);
    assert.equal(parsed.parse_metadata.confidence_score, 0.92);
  });

  it("Test 2: parserOutputSchema rejects an invalid output (confidence_score > 1)", () => {
    const bad = makeValidOutput();
    bad.parse_metadata.confidence_score = 1.5;
    const res = parserOutputSchema.safeParse(bad);
    assert.ok(!res.success, "schema should reject confidence_score > 1");
  });

  it("Test 3: parseResumeFromText returns expected ParserOutput shape", async () => {
    const cvText = "Asha Rao — Senior Backend Engineer at ExampleCo since 2022-06.";
    const model = "test-model-v1";
    const valid = makeValidOutput();
    // Fixture payload only carries what the LLM "returns" — the parser
    // overwrites parse_metadata fields it owns.
    await writeFixture(cvText, model, {
      json: {
        ...valid,
        parse_metadata: { confidence_score: 0.92 },
      },
      inputTokens: 500,
      outputTokens: 300,
      costMicros: 1500 + 4500,
    });
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    const out = await parseResumeFromText(cvText, "pdf_text", {
      tenantId: TENANT,
      model,
      client,
    });
    assert.equal(out.personal.full_name, "Asha Rao");
    assert.equal(out.parse_metadata.source_format, "pdf_text");
    assert.equal(out.parse_metadata.parser_version, PARSER_VERSION);
    assert.equal(out.parse_metadata.parser_model, "local");
    assert.equal(out.parse_metadata.confidence_score, 0.92);
  });

  it("Test 4: current_role mirrors work_history[0] when LLM omits it", async () => {
    const cvText = "Test: current_role mirroring.";
    const model = "test-model-v1";
    const valid = makeValidOutput();
    // Force the LLM payload to omit current_role; parser should derive it.
    const fixturePayload = {
      ...valid,
      current_role: null,
      parse_metadata: { confidence_score: 0.85 },
    };
    await writeFixture(cvText, model, {
      json: fixturePayload,
      inputTokens: 400,
      outputTokens: 200,
      costMicros: 4000,
    });
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    const out = await parseResumeFromText(cvText, "pdf_text", {
      tenantId: TENANT,
      model,
      client,
    });
    assert.ok(out.current_role, "current_role should be derived from work_history[0]");
    assert.equal(out.current_role!.title, "Senior Backend Engineer");
    assert.equal(out.current_role!.company, "ExampleCo");
  });

  it("Test 5: empty text returns low-confidence empty output (no throw)", async () => {
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    const out = await parseResumeFromText("", "pdf_text", {
      tenantId: TENANT,
      client,
    });
    assert.equal(out.parse_metadata.confidence_score, 0);
    assert.equal(out.personal.full_name, null);
    assert.equal(out.work_history.length, 0);
  });

  it("Test 6: LLM error → low-confidence empty output (no throw)", async () => {
    const cvText = "Test: simulated LLM failure.";
    const model = "test-model-v1";
    await writeFixture(cvText, model, {
      json: makeValidOutput(),
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      throw: { message: "simulated rate limit", code: "rate_limit_exceeded" },
    });
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    const out = await parseResumeFromText(cvText, "pdf_text", {
      tenantId: TENANT,
      model,
      client,
    });
    assert.equal(out.parse_metadata.confidence_score, 0);
    assert.equal(out.personal.full_name, null);
  });

  it("Test 7: invalid LLM JSON → low-confidence empty (no throw)", async () => {
    const cvText = "Test: malformed LLM output.";
    const model = "test-model-v1";
    // Fixture returns JSON missing required fields — schema will reject.
    await writeFixture(cvText, model, {
      json: { not: "the expected shape" },
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 250,
    });
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    const out = await parseResumeFromText(cvText, "pdf_text", {
      tenantId: TENANT,
      model,
      client,
    });
    assert.equal(out.parse_metadata.confidence_score, 0);
    assert.equal(out.work_history.length, 0);
  });

  it("Test 8: ai_usage_logs row written with feature='resume_parse'", async () => {
    // Wipe previous rows so we count only this test's writes.
    await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${TENANT}`;
    const cvText = "Test: usage logging.";
    const model = "test-model-v1";
    await writeFixture(cvText, model, {
      json: { ...makeValidOutput(), parse_metadata: { confidence_score: 0.8 } },
      inputTokens: 400,
      outputTokens: 200,
      costMicros: 4000,
    });
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    await parseResumeFromText(cvText, "pdf_text", { tenantId: TENANT, model, client });
    const rows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.tenantId, TENANT));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.feature, "resume_parse");
    assert.equal(rows[0]?.inputTokens, 400);
    assert.equal(rows[0]?.costMicros, 4000n);
    assert.equal(rows[0]?.succeeded, true);
  });

  it("Test 9: extractText rejects unsupported mime types with ExtractionError", async () => {
    let caught: unknown;
    try {
      await extractText(Buffer.from("hello"), "text/plain");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ExtractionError, "should throw ExtractionError");
    assert.match((caught as ExtractionError).message, /unsupported mime type/i);
  });

  it("Test 10: parseResume swallows ExtractionError → low-confidence empty output", async () => {
    const client = new LocalAIClient({ tenantId: TENANT, fixtureDir });
    const out = await parseResume(Buffer.from("not a real pdf"), "image/png", {
      tenantId: TENANT,
      client,
    });
    assert.equal(out.parse_metadata.source_format, "unknown");
    assert.equal(out.parse_metadata.confidence_score, 0);
    assert.equal(out.personal.full_name, null);
  });
});
