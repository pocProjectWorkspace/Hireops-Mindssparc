/**
 * N3.1b tests for the AssemblyAI ASR adapter.
 *
 * N3.1 proved the ASR abstraction against Deepgram (a synchronous vendor).
 * The client then chose AssemblyAI, which is an ASYNC vendor — upload,
 * create a job, poll it — so these cases exist mostly to pin the behaviours
 * that asynchrony introduces and that the N3.3 drain worker will depend on.
 *
 * Coverage (8 cases):
 *   1. The three-step flow (upload → create → poll) issues exactly the
 *      requests we expect, and a queued → processing → completed transition
 *      takes the happy path
 *   2. Utterances map onto the interview_transcripts segment shape with
 *      monotonic ms offsets and anonymous speaker labels
 *   3. A real cost_micros and zero tokens are logged, once, with reconcilable
 *      metadata
 *   4. A vendor `status: "error"` is NON-retryable and still logs
 *   5. A poll deadline is RETRYABLE and still logs
 *   6. HTTP failure taxonomy: 5xx retryable, upload 4xx = unsupported media,
 *      401 non-retryable but not a media error
 *   7. AssemblyAI is the default tier; the missing-key error is actionable;
 *      ASR_PROVIDER=deepgram and ASR_CLIENT_MODE=local still work
 *   8. Pricing + region resolution (US default, EU opt-in)
 *
 * NOTHING HERE TOUCHES AssemblyAI's REAL API. Every case stubs
 * globalThis.fetch; no case constructs a client with a real key or a real
 * base URL that could resolve.
 */

import "../src/bootstrap";

import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { strict as assert } from "node:assert";
import {
  getASRClient,
  resetASRClient,
  AssemblyAIASRClient,
  LocalASRClient,
  computeASRCostMicros,
  resolveAssemblyAIBaseUrl,
  ASSEMBLYAI_US_BASE_URL,
  ASSEMBLYAI_EU_BASE_URL,
  DEFAULT_ASSEMBLYAI_MODEL,
  ASRError,
  ASRUnsupportedMediaError,
  type ASRSegment,
} from "@hireops/ai-client";
import { sql as poolSql, db, aiUsageLogs } from "@hireops/db";
import { eq } from "drizzle-orm";

// N3.1b synth tenants — hex-only suffixes, distinct from N3.1's.
const ASM_TENANT = "00000000-0000-0000-0000-00000a5c1b01";
const ASM_TENANT_FAIL = "00000000-0000-0000-0000-00000a5c1b02";
const ASM_TENANT_ENV = "00000000-0000-0000-0000-00000a5c1b03";

const ALL_ASM_TENANTS = [ASM_TENANT, ASM_TENANT_FAIL, ASM_TENANT_ENV];

const AUDIO = Buffer.from("fake-webm-bytes-for-an-interview-recording");
/** Never a real host: if a stub ever fails to intercept, DNS fails loudly. */
const TEST_BASE_URL = "https://assemblyai.invalid";

/** One captured fetch call, in the order the adapter made it. */
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyJson?: Record<string, unknown>;
  bodyBytes?: number;
}

/**
 * Stubs globalThis.fetch with a scripted sequence of responses and records
 * what the adapter sent. A handler is used rather than a fixed array so the
 * poll cases can answer "processing" indefinitely.
 */
function stubFetch(handler: (call: RecordedCall, index: number) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
    };
    if (typeof init?.body === "string") {
      call.bodyJson = JSON.parse(init.body) as Record<string, unknown>;
    } else if (init?.body instanceof Uint8Array) {
      call.bodyBytes = init.body.byteLength;
    }
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A client whose timings are milliseconds, so the suite stays fast. */
function fastClient(tenantId: string, over: Record<string, number> = {}): AssemblyAIASRClient {
  return new AssemblyAIASRClient({
    tenantId,
    apiKey: "aai-test-key",
    baseUrl: TEST_BASE_URL,
    overallTimeoutMs: 2_000,
    pollIntervalMs: 5,
    maxPollIntervalMs: 10,
    ...over,
  });
}

async function cleanupASMTenants(): Promise<void> {
  for (const id of ALL_ASM_TENANTS) {
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

/**
 * A 30-minute two-speaker interview in AssemblyAI's documented completed
 * shape. Offsets are MILLISECONDS (their convention on both words and
 * utterances) and audio_duration is SECONDS — the mismatch is theirs, and
 * getting it wrong is the single most likely way this adapter breaks.
 */
const COMPLETED = {
  id: "tr-abc-123",
  status: "completed",
  language_code: "en",
  audio_duration: 1800,
  text: "Tell me about Kafka. I ran a twelve broker cluster.",
  utterances: [
    { speaker: "A", start: 500, end: 3250, text: "Tell me about Kafka." },
    { speaker: "B", start: 3500, end: 9000, text: "I ran a twelve broker cluster." },
    // Whitespace-only turns are dropped rather than stored as empty segments.
    { speaker: "B", start: 9200, end: 9400, text: "   " },
  ],
};

describe("assemblyai asr adapter (N3.1b)", () => {
  beforeAll(async () => {
    await cleanupASMTenants();
    for (const id of ALL_ASM_TENANTS) {
      const slug = `synth-n31b-${id.slice(-6)}`;
      await poolSql`
        INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
        VALUES (${id}, ${slug}, 'N3.1b Synth', 'ap-northeast-1', 'active')
      `;
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetASRClient();
  });

  afterAll(async () => {
    await cleanupASMTenants();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: upload → create → poll, and queued/processing resolve to completed", async () => {
    const calls = stubFetch((_call, i) => {
      if (i === 0) return json({ upload_url: "https://cdn.assemblyai.invalid/upload/xyz" });
      if (i === 1) return json({ id: "tr-abc-123", status: "queued" });
      if (i === 2) return json({ id: "tr-abc-123", status: "queued" });
      if (i === 3) return json({ id: "tr-abc-123", status: "processing" });
      return json(COMPLETED);
    });

    const client = fastClient(ASM_TENANT);
    try {
      const res = await client.transcribe(AUDIO, {
        contentType: "audio/webm",
        durationSecondsHint: 999,
      });

      assert.equal(calls.length, 5, "one upload, one create, three polls");

      // Step 1 — raw bytes, octet-stream, bare-token auth header.
      const upload = calls[0]!;
      assert.equal(upload.url, `${TEST_BASE_URL}/v2/upload`);
      assert.equal(upload.method, "POST");
      assert.equal(upload.headers.authorization, "aai-test-key");
      assert.equal(upload.headers["Content-Type"], "application/octet-stream");
      assert.equal(upload.bodyBytes, AUDIO.byteLength, "the whole buffer is uploaded");

      // Step 2 — the job. Diarisation is what populates segments.speaker,
      // so assert we actually asked for it.
      const create = calls[1]!;
      assert.equal(create.url, `${TEST_BASE_URL}/v2/transcript`);
      assert.equal(create.method, "POST");
      assert.equal(create.bodyJson?.audio_url, "https://cdn.assemblyai.invalid/upload/xyz");
      assert.equal(create.bodyJson?.speaker_labels, true);
      assert.equal(create.bodyJson?.speech_model, DEFAULT_ASSEMBLYAI_MODEL);
      assert.equal(create.bodyJson?.language_code, "en");

      // Step 3 — polling the job by id until it settles.
      for (const poll of calls.slice(2)) {
        assert.equal(poll.url, `${TEST_BASE_URL}/v2/transcript/tr-abc-123`);
        assert.equal(poll.method, "GET");
        assert.equal(poll.headers.authorization, "aai-test-key");
      }

      assert.equal(res.provider, "assemblyai");
      assert.equal(res.providerModel, "universal");
      assert.equal(res.language, "en");
      // The vendor measured the media; that beats the caller's hint because
      // it is what the invoice is computed from.
      assert.equal(res.durationSeconds, 1800);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT}`;
    }
  });

  it("Test 2: utterances map onto the interview_transcripts segment shape", async () => {
    stubFetch((_call, i) => {
      if (i === 0) return json({ upload_url: "https://cdn.assemblyai.invalid/upload/xyz" });
      if (i === 1) return json({ id: "tr-abc-123", status: "queued" });
      return json(COMPLETED);
    });

    const client = fastClient(ASM_TENANT);
    try {
      const res = await client.transcribe(AUDIO, { contentType: "audio/webm" });

      // Their ms offsets are copied straight through — no ×1000 anywhere —
      // and "A"/"B" become the same anonymous vocabulary Deepgram produces.
      // No semantic role is invented: ASR cannot know who the candidate is.
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
      assert.ok(
        res.segments.every((s) => /^speaker_\d+$/.test(s.speaker)),
        "labels must stay anonymous",
      );
      assert.equal(res.fullText, "Tell me about Kafka. I ran a twelve broker cluster.");
      assert.equal(res.wordCount, 10);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT}`;
    }
  });

  it("Test 3: exactly one ledger row, real cost_micros, zero tokens", async () => {
    stubFetch((_call, i) => {
      if (i === 0) return json({ upload_url: "https://cdn.assemblyai.invalid/upload/xyz" });
      if (i === 1) return json({ id: "tr-abc-123", status: "queued" });
      if (i === 2) return json({ id: "tr-abc-123", status: "processing" });
      return json(COMPLETED);
    });

    const client = fastClient(ASM_TENANT);
    try {
      const res = await client.transcribe(AUDIO, { contentType: "audio/webm" });
      // 30 minutes of Universal at $0.0045/min = 135,000 micros ($0.135).
      assert.equal(res.costMicros, computeASRCostMicros("universal", 1800));
      assert.equal(res.costMicros, 135000n);

      const rows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.tenantId, ASM_TENANT));
      assert.equal(rows.length, 1, "exactly one ledger row per transcribe(), not one per request");
      const row = rows[0]!;
      assert.equal(row.provider, "assemblyai");
      assert.equal(row.model, "universal");
      assert.equal(row.feature, "asr_transcription");
      assert.equal(row.inputTokens, 0, "zero because ASR is not token-priced");
      assert.equal(row.outputTokens, 0, "zero because ASR is not token-priced");
      assert.equal(row.costMicros, 135000n, "real money, derived from duration");
      assert.equal(row.succeeded, true);

      // Enough to reconcile this line against an AssemblyAI invoice.
      const meta = row.metadata as Record<string, unknown>;
      assert.equal(meta.durationSeconds, 1800);
      assert.equal(meta.contentType, "audio/webm");
      assert.equal(meta.providerTranscriptId, "tr-abc-123");
      assert.equal(meta.segmentCount, 2);
      assert.equal(meta.pollAttempts, 2);
      assert.equal(meta.endpoint, TEST_BASE_URL, "which region processed the minutes");
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT}`;
    }
  });

  it("Test 4: a vendor status:'error' is NON-retryable and still logs", async () => {
    stubFetch((_call, i) => {
      if (i === 0) return json({ upload_url: "https://cdn.assemblyai.invalid/upload/xyz" });
      if (i === 1) return json({ id: "tr-bad-1", status: "queued" });
      return json({
        id: "tr-bad-1",
        status: "error",
        error: "Transcoding failed: file does not appear to contain audio",
      });
    });

    const client = fastClient(ASM_TENANT_FAIL);
    try {
      let caught: unknown;
      try {
        await client.transcribe(AUDIO, { contentType: "audio/x-weird", durationSecondsHint: 30 });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRError, "expected an ASRError");
      const err = caught as ASRError;
      // The job RAN and the vendor rejected the media. Retrying re-uploads
      // the same bytes, burns N3.3's attempt cap and pays for the privilege.
      assert.equal(err.retryable, false, "the same bytes will fail the same way");
      assert.ok(
        err instanceof ASRUnsupportedMediaError,
        "a transcoding failure is a media rejection",
      );
      assert.match(err.message, /Transcoding failed/);

      const rows = await db
        .select()
        .from(aiUsageLogs)
        .where(eq(aiUsageLogs.tenantId, ASM_TENANT_FAIL));
      assert.equal(rows.length, 1, "failures are logged too");
      assert.equal(rows[0]?.succeeded, false);
      assert.equal(rows[0]?.errorCode, "transcript_error");
      assert.equal(rows[0]?.costMicros, 0n, "a rejected job bills nothing we can see");
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT_FAIL}`;
    }
  });

  it("Test 5: a poll deadline is RETRYABLE, bounded, and still logs", async () => {
    let polls = 0;
    stubFetch((_call, i) => {
      if (i === 0) return json({ upload_url: "https://cdn.assemblyai.invalid/upload/xyz" });
      if (i === 1) return json({ id: "tr-slow-1", status: "queued" });
      polls += 1;
      return json({ id: "tr-slow-1", status: "processing" });
    });

    // 300ms of budget at a 5ms poll interval: the loop must exit on the
    // deadline, not on a response.
    const client = fastClient(ASM_TENANT_FAIL, { overallTimeoutMs: 300 });
    const started = Date.now();
    try {
      let caught: unknown;
      try {
        await client.transcribe(AUDIO, { contentType: "audio/webm", durationSecondsHint: 1800 });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRError, "expected an ASRError");
      const err = caught as ASRError;
      // A slow queue is a bad minute at the vendor, not a property of the
      // file — so N3.3 should try again rather than fail the row for good.
      assert.equal(err.retryable, true, "a deadline is transient");
      assert.match(err.message, /did not complete within/);
      assert.ok(polls > 0, "it actually polled");
      assert.ok(Date.now() - started < 5_000, "the loop is bounded, not infinite");

      const rows = await db
        .select()
        .from(aiUsageLogs)
        .where(eq(aiUsageLogs.tenantId, ASM_TENANT_FAIL));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.succeeded, false);
      assert.equal(rows[0]?.errorCode, "poll_deadline_exceeded");
      const meta = rows[0]?.metadata as Record<string, unknown>;
      assert.equal(meta.providerTranscriptId, "tr-slow-1");
      assert.ok((meta.pollAttempts as number) > 0);
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT_FAIL}`;
    }
  });

  it("Test 6: HTTP failure taxonomy — 5xx retryable, upload 4xx media, 401 neither", async () => {
    const client = fastClient(ASM_TENANT_FAIL);
    try {
      // 503 on the create call: transient.
      stubFetch((_call, i) => {
        if (i === 0) return json({ upload_url: "https://cdn.assemblyai.invalid/upload/xyz" });
        return new Response("upstream unavailable", { status: 503 });
      });
      let caught: unknown;
      try {
        await client.transcribe(AUDIO, { contentType: "audio/webm" });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRError);
      assert.equal((caught as ASRError).retryable, true, "5xx is a bad minute, not a bad file");
      assert.equal(
        (await lastErrorCode(ASM_TENANT_FAIL)) ?? "",
        "http_503_create",
        "the stage is recorded so ops can tell upload from poll",
      );
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT_FAIL}`;

      // 413 on the upload: the vendor refused these bytes.
      vi.unstubAllGlobals();
      stubFetch(() => new Response("payload too large", { status: 413 }));
      caught = undefined;
      try {
        await client.transcribe(AUDIO, { contentType: "audio/webm" });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRUnsupportedMediaError, "expected ASRUnsupportedMediaError");
      assert.equal((caught as ASRError).retryable, false);
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT_FAIL}`;

      // 401: non-retryable, but NOT a media error — the file is fine, the
      // deployment is not, and the message has to say so.
      vi.unstubAllGlobals();
      stubFetch(() => new Response("unauthorized", { status: 401 }));
      caught = undefined;
      try {
        await client.transcribe(AUDIO, { contentType: "audio/webm" });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRError);
      assert.ok(
        !(caught instanceof ASRUnsupportedMediaError),
        "a bad key must not be blamed on the audio",
      );
      assert.equal((caught as ASRError).retryable, false);
      assert.match((caught as ASRError).message, /ASSEMBLYAI_API_KEY/);

      // Zero-byte audio never reaches the network at all.
      vi.unstubAllGlobals();
      const calls = stubFetch(() => json({}));
      caught = undefined;
      try {
        await client.transcribe(Buffer.alloc(0), { contentType: "audio/webm" });
      } catch (e: unknown) {
        caught = e;
      }
      assert.ok(caught instanceof ASRUnsupportedMediaError);
      assert.equal(calls.length, 0, "an empty buffer must not spend a request");
    } finally {
      await poolSql`DELETE FROM public.ai_usage_logs WHERE tenant_id = ${ASM_TENANT_FAIL}`;
    }
  });

  it("Test 7: AssemblyAI is the default tier and the missing-key error is actionable", () => {
    const prev = {
      nodeEnv: process.env.NODE_ENV,
      mode: process.env.ASR_CLIENT_MODE,
      provider: process.env.ASR_PROVIDER,
      aaiKey: process.env.ASSEMBLYAI_API_KEY,
      dgKey: process.env.DEEPGRAM_API_KEY,
    };
    process.env.NODE_ENV = "production";
    delete process.env.ASR_CLIENT_MODE;
    delete process.env.ASR_PROVIDER;
    delete process.env.ASSEMBLYAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    resetASRClient();
    try {
      // Default tier is now AssemblyAI, so that is the key it asks for.
      let msg = "";
      try {
        getASRClient(ASM_TENANT_ENV);
      } catch (e: unknown) {
        msg = e instanceof Error ? e.message : String(e);
      }
      assert.match(msg, /ASSEMBLYAI_API_KEY/, `unexpected message: ${msg}`);
      assert.match(msg, /ASR_CLIENT_MODE=local/, "must say how to run without a key");
      assert.match(msg, /ASR_PROVIDER=deepgram/, "must say how to reach the other vendor");

      process.env.ASSEMBLYAI_API_KEY = "aai-test-key";
      resetASRClient();
      const client = getASRClient(ASM_TENANT_ENV);
      assert.equal(client.provider, "assemblyai");
      assert.ok(client instanceof AssemblyAIASRClient);
      assert.ok(getASRClient(ASM_TENANT_ENV) === client, "still cached per tenant");

      // Deepgram is one env var away, not deleted.
      process.env.ASR_PROVIDER = "deepgram";
      resetASRClient();
      let dgMsg = "";
      try {
        getASRClient(ASM_TENANT_ENV);
      } catch (e: unknown) {
        dgMsg = e instanceof Error ? e.message : String(e);
      }
      assert.match(dgMsg, /DEEPGRAM_API_KEY/, "explicit selection reaches the Deepgram tier");
      process.env.DEEPGRAM_API_KEY = "dg-test-key";
      resetASRClient();
      assert.equal(getASRClient(ASM_TENANT_ENV).provider, "deepgram");

      // A typo must not silently bill the default vendor.
      process.env.ASR_PROVIDER = "assmeblyai";
      resetASRClient();
      let typoMsg = "";
      try {
        getASRClient(ASM_TENANT_ENV);
      } catch (e: unknown) {
        typoMsg = e instanceof Error ? e.message : String(e);
      }
      assert.match(typoMsg, /Unknown ASR_PROVIDER/);

      // The local tier still outranks ASR_PROVIDER — no env var can talk a
      // test into calling a vendor.
      process.env.ASR_CLIENT_MODE = "local";
      resetASRClient();
      assert.ok(getASRClient(ASM_TENANT_ENV) instanceof LocalASRClient);
      delete process.env.ASR_CLIENT_MODE;
      process.env.NODE_ENV = "test";
      resetASRClient();
      assert.ok(getASRClient(ASM_TENANT_ENV) instanceof LocalASRClient);
    } finally {
      if (prev.nodeEnv !== undefined) process.env.NODE_ENV = prev.nodeEnv;
      else delete process.env.NODE_ENV;
      if (prev.mode !== undefined) process.env.ASR_CLIENT_MODE = prev.mode;
      else delete process.env.ASR_CLIENT_MODE;
      if (prev.provider !== undefined) process.env.ASR_PROVIDER = prev.provider;
      else delete process.env.ASR_PROVIDER;
      if (prev.aaiKey !== undefined) process.env.ASSEMBLYAI_API_KEY = prev.aaiKey;
      else delete process.env.ASSEMBLYAI_API_KEY;
      if (prev.dgKey !== undefined) process.env.DEEPGRAM_API_KEY = prev.dgKey;
      else delete process.env.DEEPGRAM_API_KEY;
      resetASRClient();
    }
  });

  it("Test 8: per-minute pricing and region resolution", () => {
    // Universal = $0.27/hr = $0.0045/min = 4,500 micros/min.
    assert.equal(computeASRCostMicros("universal", 60), 4500n, "one minute");
    assert.equal(computeASRCostMicros("universal", 1800), 135000n, "a 30-minute interview");
    assert.equal(computeASRCostMicros("best", 60), 4500n, "the legacy alias resolves to Universal");
    // Nano = $0.12/hr = $0.002/min, and sub-minute cost rounds UP.
    assert.equal(computeASRCostMicros("nano", 60), 2000n);
    assert.equal(computeASRCostMicros("nano", 1), 34n, "33.33 micros rounds up to 34");
    // The unknown-model fallback is still the highest rate in the merged
    // table, never AssemblyAI's cheap tier.
    assert.equal(computeASRCostMicros("some-future-model", 60), 5200n);
    // Deepgram's entries are untouched by the merge.
    assert.equal(computeASRCostMicros("nova-3", 60), 4300n);

    const prev = {
      base: process.env.ASSEMBLYAI_BASE_URL,
      region: process.env.ASSEMBLYAI_REGION,
    };
    delete process.env.ASSEMBLYAI_BASE_URL;
    delete process.env.ASSEMBLYAI_REGION;
    try {
      // US is a default, not a decision — residency is still open with the
      // client (CLIENT-implementation-checklist §1.1).
      assert.equal(resolveAssemblyAIBaseUrl(), ASSEMBLYAI_US_BASE_URL);
      process.env.ASSEMBLYAI_REGION = "EU";
      assert.equal(
        resolveAssemblyAIBaseUrl(),
        ASSEMBLYAI_EU_BASE_URL,
        "region is case-insensitive",
      );
      process.env.ASSEMBLYAI_BASE_URL = "https://api.example.invalid/";
      assert.equal(
        resolveAssemblyAIBaseUrl(),
        "https://api.example.invalid",
        "an explicit host wins and loses its trailing slash",
      );
    } finally {
      if (prev.base !== undefined) process.env.ASSEMBLYAI_BASE_URL = prev.base;
      else delete process.env.ASSEMBLYAI_BASE_URL;
      if (prev.region !== undefined) process.env.ASSEMBLYAI_REGION = prev.region;
      else delete process.env.ASSEMBLYAI_REGION;
    }
  });
});

async function lastErrorCode(tenantId: string): Promise<string | null | undefined> {
  const rows = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.tenantId, tenantId));
  return rows[rows.length - 1]?.errorCode;
}
