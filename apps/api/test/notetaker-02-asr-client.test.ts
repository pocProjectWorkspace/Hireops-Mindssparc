/**
 * N3.1 tests for the ASR (speech-to-text) client adapter.
 *
 * Coverage (9 cases):
 *   1. getASRClient returns LocalASRClient under NODE_ENV=test, and caches
 *      per tenant
 *   2. Local output is deterministic and shaped to interview_transcripts
 *      (monotonic offsets, multi-speaker, non-empty full_text)
 *   3. The duration hint drives transcript length; different audio yields a
 *      different transcript
 *   4. Fixture tier — an exact transcript keyed by hashTranscribeInput
 *   5. Local writes an ai_usage_logs row with zero tokens, zero cost and
 *      the duration in metadata
 *   6. computeASRCostMicros converts duration → micros at the published
 *      per-minute rate, including the unknown-model fallback and the
 *      zero/negative guards
 *   7. DeepgramASRClient maps a canned response onto ASRResult and logs a
 *      REAL cost_micros with zero tokens (fetch is stubbed — no vendor call)
 *   8. Deepgram HTTP 415 raises the non-retryable media error
 *   9. Missing DEEPGRAM_API_KEY throws an actionable error; ASR_CLIENT_MODE
 *      =local overrides it
 *
 * Nothing here touches Deepgram's real API. Case 7/8 stub globalThis.fetch;
 * every other case runs on the local tier, which has no network path at all.
 */

import "../src/bootstrap";

import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getASRClient,
  resetASRClient,
  LocalASRClient,
  DeepgramASRClient,
  hashTranscribeInput,
  computeASRCostMicros,
  ASR_USAGE_FEATURE,
  ASRUnsupportedMediaError,
  type ASRSegment,
  type ASRTranscribeOptions,
} from "@hireops/ai-client";
import { sql as poolSql, db, aiUsageLogs } from "@hireops/db";
import { eq } from "drizzle-orm";

// N3.1 synth tenants — hex-only suffixes.
const ASR_TENANT = "00000000-0000-0000-0000-00000a5c1301";
const ASR_TENANT_DG = "00000000-0000-0000-0000-00000a5c1302";
const ASR_TENANT_CACHE = "00000000-0000-0000-0000-00000a5c1303";

const ALL_ASR_TENANTS = [ASR_TENANT, ASR_TENANT_DG, ASR_TENANT_CACHE];

const AUDIO = Buffer.from("fake-webm-bytes-for-an-interview-recording");
const BASE_OPTS: ASRTranscribeOptions = { contentType: "audio/webm" };

let fixtureDir: string;

async function cleanupASRTenants(): Promise<void> {
  for (const id of ALL_ASR_TENANTS) {
    await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${id}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${id}`;
  }
}

/** interview_transcripts.segments invariants the drain worker relies on. */
function assertTranscriptShape(segments: ASRSegment[]): void {
  assert.ok(segments.length > 1, "expected a multi-turn transcript");
  let prevEnd = -1;
  for (const s of segments) {
    assert.equal(typeof s.speaker, "string");
    assert.ok(s.text.trim().length > 0, "segment text must be non-empty");
    assert.ok(Number.isInteger(s.startMs) && s.startMs >= 0, `bad startMs: ${s.startMs}`);
    assert.ok(s.endMs > s.startMs, `endMs must follow startMs: ${s.startMs}..${s.endMs}`);
    assert.ok(s.startMs >= prevEnd, `offsets must be monotonic: ${prevEnd} then ${s.startMs}`);
    prevEnd = s.endMs;
  }
}

describe("asr client (N3.1)", () => {
  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "asr-fixtures-"));
    await cleanupASRTenants();
    for (const id of ALL_ASR_TENANTS) {
      const slug = `synth-n31-${id.slice(-6)}`;
      await poolSql`
        INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
        VALUES (${id}, ${slug}, 'N3.1 Synth', 'ap-northeast-1', 'active')
      `;
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetASRClient();
  });

  afterAll(async () => {
    await cleanupASRTenants();
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: getASRClient yields the local tier under NODE_ENV=test and caches per tenant", async () => {
    const a = getASRClient(ASR_TENANT_CACHE);
    assert.equal(a.provider, "local", "NODE_ENV=test must force the local tier");
    assert.ok(a instanceof LocalASRClient);
    const b = getASRClient(ASR_TENANT_CACHE);
    assert.ok(a === b, "same tenant returns the cached instance");
    const other = getASRClient(ASR_TENANT);
    assert.ok(other !== a, "a different tenant gets its own client");
    resetASRClient();
    assert.ok(getASRClient(ASR_TENANT_CACHE) !== a, "resetASRClient clears the cache");
  });

  it("Test 2: local transcription is deterministic and matches the interview_transcripts shape", async () => {
    const client = new LocalASRClient({ tenantId: ASR_TENANT, fixtureDir });
    try {
      const first = await client.transcribe(AUDIO, { ...BASE_OPTS, durationSecondsHint: 300 });
      const second = await client.transcribe(AUDIO, { ...BASE_OPTS, durationSecondsHint: 300 });

      // Everything except latencyMs, which is wall clock by definition.
      const transcriptOf = (r: typeof first) => ({
        segments: r.segments,
        fullText: r.fullText,
        language: r.language,
        wordCount: r.wordCount,
        durationSeconds: r.durationSeconds,
        providerModel: r.providerModel,
      });
      assert.deepEqual(
        transcriptOf(second),
        transcriptOf(first),
        "same audio + options must produce the same transcript",
      );

      assertTranscriptShape(first.segments);
      const speakers = new Set(first.segments.map((s) => s.speaker));
      assert.ok(speakers.size >= 2, `expected multiple speakers, got ${[...speakers].join(",")}`);

      assert.ok(first.fullText.trim().length > 0, "full_text must not be empty");
      assert.equal(
        first.wordCount,
        first.fullText.trim().split(/\s+/).length,
        "word_count must describe full_text",
      );
      assert.equal(first.provider, "local");
      assert.equal(first.language, "en");
      assert.ok(first.providerModel.length > 0, "provider_model must be stamped");
      assert.equal(
        first.durationSeconds,
        300,
        "the caller's duration is the truth about the media",
      );
      // Local mode bills nothing: no vendor call happened.
      assert.equal(first.costMicros, 0n);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASR_TENANT}`;
    }
  });

  it("Test 3: transcript length tracks the duration hint; different audio differs", async () => {
    const client = new LocalASRClient({ tenantId: ASR_TENANT, fixtureDir });
    try {
      const short = await client.transcribe(AUDIO, { ...BASE_OPTS, durationSecondsHint: 60 });
      const long = await client.transcribe(AUDIO, { ...BASE_OPTS, durationSecondsHint: 1800 });
      assert.ok(
        long.segments.length > short.segments.length,
        `30 minutes should yield more turns than 1 (${long.segments.length} vs ${short.segments.length})`,
      );
      assert.ok(
        long.segments[long.segments.length - 1]!.endMs >= 60 * 1000,
        "a 30-minute recording should not end after a minute",
      );

      const otherAudio = Buffer.from("a completely different recording");
      const other = await client.transcribe(otherAudio, {
        ...BASE_OPTS,
        durationSecondsHint: 60,
      });
      assert.notDeepEqual(
        other.segments,
        short.segments,
        "different audio must not produce an identical transcript",
      );
      assertTranscriptShape(other.segments);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASR_TENANT}`;
    }
  });

  it("Test 4: a fixture keyed by hashTranscribeInput wins over synthesis", async () => {
    const opts: ASRTranscribeOptions = {
      contentType: "audio/wav",
      language: "en",
      model: "fixture-asr-1",
      durationSecondsHint: 24,
    };
    const hash = hashTranscribeInput(AUDIO, opts);
    await writeFile(
      join(fixtureDir, `${hash}.json`),
      JSON.stringify({
        segments: [
          { speaker: "speaker_0", startMs: 0, endMs: 4000, text: "Tell me about Kafka." },
          { speaker: "speaker_1", startMs: 4000, endMs: 20000, text: "I ran a 12-broker cluster." },
        ],
        durationSeconds: 24,
      }),
    );
    const client = new LocalASRClient({ tenantId: ASR_TENANT, fixtureDir });
    try {
      const res = await client.transcribe(AUDIO, opts);
      assert.equal(res.segments.length, 2);
      assert.equal(res.segments[0]?.text, "Tell me about Kafka.");
      assert.equal(res.fullText, "Tell me about Kafka. I ran a 12-broker cluster.");
      assert.equal(res.wordCount, 9);
      assert.equal(res.providerModel, "fixture-asr-1");
      assert.equal(res.durationSeconds, 24);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASR_TENANT}`;
    }
  });

  it("Test 5: local mode logs zero tokens, zero cost, and the duration in metadata", async () => {
    const client = new LocalASRClient({ tenantId: ASR_TENANT, fixtureDir });
    try {
      await client.transcribe(AUDIO, { ...BASE_OPTS, durationSecondsHint: 600 });
      const rows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.tenantId, ASR_TENANT));
      assert.equal(rows.length, 1, "exactly one ledger row per transcribe()");
      const row = rows[0]!;
      assert.equal(row.provider, "local");
      assert.equal(row.feature, ASR_USAGE_FEATURE);
      assert.equal(row.feature, "asr_transcription");
      // Zero because ASR is not token-priced — not because it is unknown.
      assert.equal(row.inputTokens, 0);
      assert.equal(row.outputTokens, 0);
      // Zero cost because the local tier never called a vendor.
      assert.equal(row.costMicros, 0n);
      assert.equal(row.succeeded, true);
      const meta = row.metadata as Record<string, unknown>;
      assert.equal(meta.durationSeconds, 600, "the billable quantity lives in metadata");
      assert.equal(meta.localMode, true);
      // 10 minutes at the nova-3 list rate = 43,000 micros ($0.043).
      assert.equal(meta.estimatedCostMicros, 43000);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASR_TENANT}`;
    }
  });

  it("Test 6: computeASRCostMicros converts duration to micros at the per-minute rate", () => {
    // nova-3 = $0.0043/min = 4,300 micros/min.
    assert.equal(computeASRCostMicros("nova-3", 60), 4300n, "one minute");
    assert.equal(computeASRCostMicros("nova-3", 1800), 129000n, "a 30-minute interview = $0.129");
    assert.equal(computeASRCostMicros("nova-3", 30), 2150n, "half a minute bills half a minute");
    // Rounds up: 1s = 71.66 micros → 72.
    assert.equal(computeASRCostMicros("nova-3", 1), 72n, "sub-minute cost rounds up");
    // Multilingual is the dearer tier.
    assert.equal(computeASRCostMicros("nova-3-multilingual", 60), 5200n);
    // Versioned model ids resolve by prefix, longest key first.
    assert.equal(computeASRCostMicros("nova-3-multilingual-20260101", 60), 5200n);
    assert.equal(computeASRCostMicros("nova-2-general", 60), 4300n);
    // Unknown model falls back to the HIGHEST known rate, never a low one.
    assert.equal(computeASRCostMicros("some-future-model", 60), 5200n);
    // Guards.
    assert.equal(computeASRCostMicros("nova-3", 0), 0n);
    assert.equal(computeASRCostMicros("nova-3", -5), 0n);
    assert.equal(computeASRCostMicros("nova-3", Number.NaN), 0n);
  });

  it("Test 7: Deepgram response maps onto ASRResult and logs a real cost with zero tokens", async () => {
    // Canned payload in Deepgram's documented pre-recorded shape. fetch is
    // stubbed, so no request leaves the process.
    const payload = {
      metadata: {
        request_id: "req-abc-123",
        duration: 120.4,
        models: ["m-uuid-1"],
        model_info: { "m-uuid-1": { name: "nova-3", version: "2026-01-01.0" } },
      },
      results: {
        channels: [
          {
            detected_language: "en",
            alternatives: [{ transcript: "Tell me about Kafka. I ran a twelve broker cluster." }],
          },
        ],
        utterances: [
          { start: 0.5, end: 3.25, speaker: 0, transcript: "Tell me about Kafka." },
          { start: 3.5, end: 9.0, speaker: 1, transcript: "I ran a twelve broker cluster." },
          { start: 9.2, end: 9.4, speaker: 1, transcript: "   " },
        ],
      },
    };
    let seenUrl = "";
    let seenAuth = "";
    let seenContentType = "";
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      seenUrl = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenAuth = headers.Authorization ?? "";
      seenContentType = headers["Content-Type"] ?? "";
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new DeepgramASRClient({ tenantId: ASR_TENANT_DG, apiKey: "dg-test-key" });
    try {
      const res = await client.transcribe(AUDIO, {
        contentType: "audio/webm",
        durationSecondsHint: 999,
      });

      // Diarisation is what populates segments.speaker — assert we asked.
      assert.match(seenUrl, /diarize=true/);
      assert.match(seenUrl, /utterances=true/);
      assert.match(seenUrl, /model=nova-3/);
      assert.equal(seenAuth, "Token dg-test-key");
      assert.equal(seenContentType, "audio/webm");

      assert.deepEqual(res.segments, [
        { speaker: "speaker_0", startMs: 500, endMs: 3250, text: "Tell me about Kafka." },
        {
          speaker: "speaker_1",
          startMs: 3500,
          endMs: 9000,
          text: "I ran a twelve broker cluster.",
        },
      ]);
      assertTranscriptShape(res.segments);
      assert.equal(res.fullText, "Tell me about Kafka. I ran a twelve broker cluster.");
      assert.equal(res.wordCount, 10);
      assert.equal(res.provider, "deepgram");
      assert.equal(res.language, "en");
      assert.equal(res.providerModel, "nova-3-2026-01-01.0", "records the model that actually ran");
      // Deepgram's measured duration beats the caller's hint — it is what
      // the vendor bills on.
      assert.equal(res.durationSeconds, 120.4);
      assert.equal(res.costMicros, computeASRCostMicros("nova-3", 120.4));
      assert.equal(res.costMicros, 8629n);

      const rows = await db
        .select()
        .from(aiUsageLogs)
        .where(eq(aiUsageLogs.tenantId, ASR_TENANT_DG));
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.provider, "deepgram");
      assert.equal(row.model, "nova-3");
      assert.equal(row.feature, "asr_transcription");
      assert.equal(row.inputTokens, 0, "zero because ASR is not token-priced");
      assert.equal(row.outputTokens, 0, "zero because ASR is not token-priced");
      assert.equal(row.costMicros, 8629n, "real money, derived from duration");
      assert.equal(row.succeeded, true);
      const meta = row.metadata as Record<string, unknown>;
      assert.equal(meta.durationSeconds, 120.4);
      assert.equal(meta.providerRequestId, "req-abc-123");
      assert.equal(meta.segmentCount, 2);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASR_TENANT_DG}`;
    }
  });

  it("Test 8: a 4xx from Deepgram is a non-retryable media error and still logs", async () => {
    vi.stubGlobal("fetch", async () => new Response("unsupported media type", { status: 415 }));
    const client = new DeepgramASRClient({ tenantId: ASR_TENANT_DG, apiKey: "dg-test-key" });
    try {
      let caught: unknown;
      try {
        await client.transcribe(AUDIO, { contentType: "audio/x-weird", durationSecondsHint: 30 });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRUnsupportedMediaError, "expected ASRUnsupportedMediaError");
      const err = caught as ASRUnsupportedMediaError;
      assert.equal(err.retryable, false, "the same bytes will fail the same way");
      assert.match(err.message, /HTTP 415/);

      const rows = await db
        .select()
        .from(aiUsageLogs)
        .where(eq(aiUsageLogs.tenantId, ASR_TENANT_DG));
      assert.equal(rows.length, 1, "failures are logged too");
      assert.equal(rows[0]?.succeeded, false);
      assert.equal(rows[0]?.errorCode, "http_415");
      assert.equal(rows[0]?.costMicros, 0n, "a rejected request bills nothing");
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASR_TENANT_DG}`;
    }
  });

  it("Test 9: missing DEEPGRAM_API_KEY throws an actionable error; ASR_CLIENT_MODE=local overrides", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevMode = process.env.ASR_CLIENT_MODE;
    const prevProvider = process.env.ASR_PROVIDER;
    const prevKey = process.env.DEEPGRAM_API_KEY;
    process.env.NODE_ENV = "production";
    delete process.env.ASR_CLIENT_MODE;
    delete process.env.DEEPGRAM_API_KEY;
    // N3.1b made AssemblyAI the default tier, so Deepgram now has to be
    // asked for by name. Its missing-key error is unchanged; reaching it is
    // what changed. The AssemblyAI side of this dispatch is covered in
    // notetaker-02b.
    process.env.ASR_PROVIDER = "deepgram";
    resetASRClient();
    try {
      let msg = "";
      try {
        getASRClient(ASR_TENANT);
      } catch (e: unknown) {
        msg = e instanceof Error ? e.message : String(e);
      }
      assert.match(msg, /DEEPGRAM_API_KEY/, `unexpected message: ${msg}`);
      assert.match(msg, /ASR_CLIENT_MODE=local/, "must tell the reader how to run without a key");

      // The documented escape hatch actually works, with no key present.
      process.env.ASR_CLIENT_MODE = "local";
      resetASRClient();
      assert.equal(getASRClient(ASR_TENANT).provider, "local");
    } finally {
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
      if (prevMode !== undefined) process.env.ASR_CLIENT_MODE = prevMode;
      else delete process.env.ASR_CLIENT_MODE;
      if (prevProvider !== undefined) process.env.ASR_PROVIDER = prevProvider;
      else delete process.env.ASR_PROVIDER;
      if (prevKey !== undefined) process.env.DEEPGRAM_API_KEY = prevKey;
      resetASRClient();
    }
  });
});
