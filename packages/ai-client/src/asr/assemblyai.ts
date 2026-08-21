import { recordAIUsage } from "../usage-log";
import { computeASRCostMicros, ASR_USAGE_FEATURE } from "../asr-pricing";
import { ASRError, ASRUnsupportedMediaError } from "./types";
import type { ASRClient, ASRResult, ASRSegment, ASRTranscribeOptions } from "./types";

/**
 * AssemblyAI pre-recorded transcription over plain `fetch` — N3.1b.
 *
 * The client picked AssemblyAI after N3.1 shipped against Deepgram.
 * `deepgram.ts` stays: two live implementations behind one ASRClient is the
 * only real proof that the abstraction holds, and reverting is then a
 * one-env-var decision rather than a rewrite.
 *
 * WHY REST AND NOT assemblyai's SDK — the three reasons in deepgram.ts's
 * header apply unchanged (open vendor decision, trivial HTTP surface, and
 * this package deliberately keeps its vendor SDKs as optional peer deps).
 * The credential is likewise a PLATFORM key from the environment, not a
 * per-tenant BYO credential: ASR bills per audio-minute against our account
 * whether or not the tenant brings its own LLM key, which is why every call
 * below writes a cost row (COMMERCIAL-sizing-and-hosting-cost-model.md §5.3).
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM DEEPGRAM: THIS VENDOR IS ASYNC
 * -----------------------------------------------------------------
 * Deepgram's pre-recorded endpoint holds the connection until the whole file
 * is transcribed — one request, one response. AssemblyAI is a job queue:
 *
 *   1. POST /v2/upload      raw bytes           → { upload_url }
 *   2. POST /v2/transcript  { audio_url, … }    → { id, status: "queued" }
 *   3. GET  /v2/transcript/{id}  polled         → status becomes
 *                                                 "completed" | "error"
 *
 * AssemblyAI also supports a completion webhook (`webhook_url` on step 2),
 * which would collapse this long poll into an event and free the worker slot
 * for the minutes the job actually takes. This codebase has NO inbound
 * webhook endpoints at all today — ai-interview-build-plan.md §3 defers the
 * first HMAC-verified inbound route to the Phase 3 vendor adapter — so
 * polling is the only option now. When that route is built, this adapter is
 * its natural first companion: the poll loop becomes a callback and the
 * wall-clock budget below stops mattering.
 *
 * WALL-CLOCK BUDGET (N3.3 MUST SIZE ITS LEASE ABOVE THIS)
 * -------------------------------------------------------
 * Worst case for one transcribe() is DEFAULT_OVERALL_TIMEOUT_MS
 * (20 minutes), which covers upload + create + the whole poll loop. The
 * expected case for a 60-minute interview is roughly 2–5 minutes: queue wait
 * plus transcription at many times real time.
 *
 * The transcript_outbox claim lease and the orphan-sweep threshold must both
 * sit ABOVE 20 minutes (30 / 45 minutes are the sane picks). If a lease
 * expires while this call is still polling, the row is reclaimed and the
 * SAME AUDIO IS TRANSCRIBED TWICE — and AssemblyAI bills both jobs. That is
 * the non-obvious cost of an async vendor: with Deepgram a premature reclaim
 * wasted a worker slot, here it doubles a real COGS line.
 *
 * NOTE ON SPEAKER LABELS: with `speaker_labels: true` AssemblyAI returns
 * anonymous letters — "A", "B", "C". Exactly like Deepgram's integer
 * indices, they say "these turns came from the same voice" and nothing more.
 * No ASR vendor can know which voice is the candidate. We map A→speaker_0,
 * B→speaker_1 so the `interview_transcripts.segments` label vocabulary is
 * the same whichever adapter ran (the mapping is 1:1 and reversible), and we
 * do NOT invent "candidate" / "panellist" here. Role attribution is a later
 * human-or-model step (N3.3/N3.4).
 */

/**
 * US and EU control planes. Same API, different data residency.
 *
 * DATA RESIDENCY IS AN OPEN CLIENT DECISION — CLIENT-implementation-checklist
 * §1.1 has it as a 🔴 blocking item, and COMMERCIAL-sizing §S5 notes it can
 * invalidate the hosting quote outright. So the base URL is env-configurable
 * and the US host is only a default, not a position: whoever pins the region
 * is making a deliberate config choice. The resolved host is stamped into
 * every usage-log row so "where were these minutes processed?" is answerable
 * from the ledger rather than from deployment archaeology.
 */
export const ASSEMBLYAI_US_BASE_URL = "https://api.assemblyai.com";
export const ASSEMBLYAI_EU_BASE_URL = "https://api.eu.assemblyai.com";

/**
 * AssemblyAI's current general-purpose async model. Priced in
 * asr-pricing.ts. Sent as `speech_model` on the create call.
 */
export const DEFAULT_ASSEMBLYAI_MODEL = "universal";

/**
 * Whole-call budget: upload + create + poll. Twenty minutes is generous for
 * a 60-minute recording (see the header) and still bounded, so a stuck job
 * cannot pin a drain worker slot indefinitely.
 */
const DEFAULT_OVERALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Per-request ceilings inside that budget. The upload is the only call that
 * moves real bytes — a 60-minute recording is tens of megabytes — so it gets
 * minutes; the JSON control-plane calls get a minute.
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;

/**
 * Poll cadence. Starts at 3s so a short clip returns quickly, then backs off
 * ×1.5 to a 20s ceiling — a long interview is minutes of work and polling it
 * every three seconds is several hundred pointless requests against a
 * rate-limited API.
 */
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 20_000;
const POLL_BACKOFF_FACTOR = 1.5;

export interface AssemblyAIASRClientOpts {
  tenantId: string;
  apiKey: string;
  /**
   * Override for tests / region pinning. Defaults to
   * resolveAssemblyAIBaseUrl() — i.e. env, then the US host.
   */
  baseUrl?: string;
  /** Whole-call wall-clock budget. See the header before raising it. */
  overallTimeoutMs?: number;
  uploadTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
}

/**
 * Region resolution, in precedence order:
 *   ASSEMBLYAI_BASE_URL  — explicit host (also covers a future third region)
 *   ASSEMBLYAI_REGION=eu — the published EU control plane
 *   default              — US
 */
export function resolveAssemblyAIBaseUrl(): string {
  const explicit = process.env.ASSEMBLYAI_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const region = process.env.ASSEMBLYAI_REGION?.trim().toLowerCase();
  if (region === "eu") return ASSEMBLYAI_EU_BASE_URL;
  return ASSEMBLYAI_US_BASE_URL;
}

/**
 * The subset of AssemblyAI's responses we depend on. Optional throughout for
 * the same reason as the Deepgram interfaces: this is untrusted JSON off the
 * wire and a missing field should degrade the transcript, not throw a
 * TypeError three frames deep inside a worker.
 */
interface AssemblyAIUploadResponse {
  upload_url?: string;
}

interface AssemblyAIUtterance {
  /** Milliseconds. AssemblyAI reports every offset in ms — see mapSegments. */
  start?: number;
  end?: number;
  text?: string;
  /** Anonymous diarisation label: "A", "B", … */
  speaker?: string;
}

interface AssemblyAITranscript {
  id?: string;
  status?: string;
  text?: string | null;
  language_code?: string | null;
  /** Seconds. The billable quantity. */
  audio_duration?: number | null;
  utterances?: AssemblyAIUtterance[] | null;
  /** Populated when status === "error". */
  error?: string | null;
}

export class AssemblyAIASRClient implements ASRClient {
  readonly provider = "assemblyai" as const;
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly overallTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;

  constructor(opts: AssemblyAIASRClientOpts) {
    this.tenantId = opts.tenantId;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? resolveAssemblyAIBaseUrl()).replace(/\/+$/, "");
    this.overallTimeoutMs = opts.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollIntervalMs = opts.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
  }

  async transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult> {
    const start = Date.now();
    const deadline = start + this.overallTimeoutMs;
    const model = opts.model ?? DEFAULT_ASSEMBLYAI_MODEL;
    const feature = opts.feature ?? ASR_USAGE_FEATURE;
    const language = opts.language ?? "en";

    if (audio.length === 0) {
      // Fail before spending a request; an empty body is a rejected upload
      // every time.
      await this.writeUsage({
        model,
        feature,
        opts,
        durationSeconds: 0,
        costMicros: 0n,
        latencyMs: Date.now() - start,
        succeeded: false,
        errorCode: "empty_media",
      });
      throw new ASRUnsupportedMediaError(
        "AssemblyAIASRClient: refusing to transcribe a zero-byte audio buffer.",
        opts.contentType,
      );
    }

    // Step 1 — upload the bytes. Nothing is billed yet; this endpoint only
    // parks the media on their CDN and hands back a URL.
    const uploadUrl = await this.upload(audio, opts, { model, feature, start, deadline });

    // Step 2 — create the job.
    const created = await this.createTranscript(uploadUrl, language, model, opts, {
      model,
      feature,
      start,
      deadline,
    });
    const transcriptId = created.id;
    if (!transcriptId) {
      await this.writeUsage({
        model,
        feature,
        opts,
        durationSeconds: opts.durationSecondsHint ?? 0,
        costMicros: 0n,
        latencyMs: Date.now() - start,
        succeeded: false,
        errorCode: "missing_transcript_id",
      });
      throw new ASRError(
        "AssemblyAIASRClient: create-transcript returned no id; cannot poll for a result.",
        // Retryable: a malformed response is far more likely to be a bad
        // minute at the vendor than a permanent property of this audio.
        true,
      );
    }

    // Step 3 — poll to completion.
    const { transcript, pollAttempts } = await this.poll(transcriptId, opts, {
      model,
      feature,
      start,
      deadline,
    });

    const latencyMs = Date.now() - start;
    const segments = mapSegments(transcript);
    const fullText = flattenTranscript(transcript, segments);
    // AssemblyAI measures the media itself and bills on that, so it wins over
    // the caller's hint whenever it is present.
    const durationSeconds = transcript.audio_duration ?? opts.durationSecondsHint ?? 0;
    const costMicros = computeASRCostMicros(model, durationSeconds);

    if (segments.length === 0) {
      // Silence, or audio the model could not resolve into words. Not an
      // error — a genuinely silent recording is a real outcome — but the
      // minutes were still billed, so the log row is written the same way
      // and the empty result is returned.
      console.warn(
        `[ai-client] AssemblyAI returned no utterances for a ${durationSeconds}s recording ` +
          `(transcript_id=${transcriptId}).`,
      );
    }

    await this.writeUsage({
      model,
      feature,
      opts,
      durationSeconds,
      costMicros,
      latencyMs,
      succeeded: true,
      providerTranscriptId: transcriptId,
      segmentCount: segments.length,
      pollAttempts,
    });

    return {
      segments,
      fullText,
      language: transcript.language_code ?? language,
      provider: this.provider,
      // AssemblyAI does not echo a resolved build id the way Deepgram's
      // model_info does, so the requested speech_model is the most specific
      // thing we can honestly stamp on provider_model.
      providerModel: model,
      wordCount: countWords(fullText),
      durationSeconds,
      costMicros,
      latencyMs,
    };
  }

  /** POST /v2/upload — raw bytes in, `upload_url` out. */
  private async upload(
    audio: Buffer,
    opts: ASRTranscribeOptions,
    ctx: CallContext,
  ): Promise<string> {
    const res = await this.request(
      `${this.baseUrl}/v2/upload`,
      {
        method: "POST",
        headers: {
          authorization: this.apiKey,
          // Documented for this endpoint, and deliberately NOT opts.contentType:
          // unlike Deepgram (where the request Content-Type IS the media type)
          // AssemblyAI transcodes and sniffs the container itself. The caller's
          // contentType is still carried into the usage-log metadata and the
          // media-rejection error, where it is the useful diagnostic.
          "Content-Type": "application/octet-stream",
        },
        // Buffer is a Uint8Array; a view over the same memory avoids copying
        // the whole recording a second time.
        body: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
      },
      this.uploadTimeoutMs,
      opts,
      ctx,
      "upload",
    );

    const json = (await safeJson<AssemblyAIUploadResponse>(res)) ?? {};
    if (!json.upload_url) {
      await this.writeUsage({
        model: ctx.model,
        feature: ctx.feature,
        opts,
        durationSeconds: opts.durationSecondsHint ?? 0,
        costMicros: 0n,
        latencyMs: Date.now() - ctx.start,
        succeeded: false,
        errorCode: "upload_no_url",
      });
      throw new ASRError(
        "AssemblyAIASRClient: upload succeeded but returned no upload_url.",
        true, // Vendor-side oddity, not a property of the media.
      );
    }
    return json.upload_url;
  }

  /** POST /v2/transcript — queue the job. */
  private async createTranscript(
    audioUrl: string,
    language: string,
    model: string,
    opts: ASRTranscribeOptions,
    ctx: CallContext,
  ): Promise<AssemblyAITranscript> {
    const res = await this.request(
      `${this.baseUrl}/v2/transcript`,
      {
        method: "POST",
        headers: { authorization: this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_url: audioUrl,
          // Required by the interview_transcripts.segments contract — without
          // it there are no utterances and no speaker labels at all.
          speaker_labels: true,
          language_code: toAssemblyAILanguageCode(language),
          speech_model: model,
          // Both are vendor defaults today. Sent explicitly so a change to
          // those defaults cannot silently degrade the full_text we hand to
          // the summariser prompt.
          punctuate: true,
          format_text: true,
        }),
      },
      this.requestTimeoutMs,
      opts,
      ctx,
      "create",
    );
    return (await safeJson<AssemblyAITranscript>(res)) ?? {};
  }

  /**
   * GET /v2/transcript/{id} until it settles.
   *
   * Bounded by the whole-call deadline: there is no "poll forever" path, and
   * every exit either returns a completed transcript or throws with an
   * explicit retryable/non-retryable verdict for N3.3's attempt cap.
   */
  private async poll(
    transcriptId: string,
    opts: ASRTranscribeOptions,
    ctx: CallContext,
  ): Promise<{ transcript: AssemblyAITranscript; pollAttempts: number }> {
    let interval = this.pollIntervalMs;
    let attempts = 0;

    for (;;) {
      const remaining = ctx.deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining));
      interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), this.maxPollIntervalMs);
      attempts += 1;

      const res = await this.request(
        `${this.baseUrl}/v2/transcript/${encodeURIComponent(transcriptId)}`,
        { method: "GET", headers: { authorization: this.apiKey } },
        this.requestTimeoutMs,
        opts,
        ctx,
        "poll",
        { transcriptId, pollAttempts: attempts },
      );
      const transcript = (await safeJson<AssemblyAITranscript>(res)) ?? {};

      if (transcript.status === "completed") return { transcript, pollAttempts: attempts };

      if (transcript.status === "error") {
        // A terminal vendor failure. NOT retryable: the job ran and the
        // vendor decided this media does not transcribe, so re-submitting
        // the same bytes burns the attempt cap and bills for the privilege.
        const detail = transcript.error ?? "no detail supplied";
        await this.writeUsage({
          model: ctx.model,
          feature: ctx.feature,
          opts,
          durationSeconds: transcript.audio_duration ?? opts.durationSecondsHint ?? 0,
          costMicros: 0n,
          latencyMs: Date.now() - ctx.start,
          succeeded: false,
          errorCode: "transcript_error",
          providerTranscriptId: transcriptId,
          pollAttempts: attempts,
        });
        const message = `AssemblyAIASRClient: transcript ${transcriptId} failed — ${detail.slice(0, 500)}`;
        if (looksLikeMediaRejection(detail)) {
          throw new ASRUnsupportedMediaError(message, opts.contentType);
        }
        throw new ASRError(message, false);
      }

      // "queued" / "processing" — and anything we do not recognise, because a
      // status this adapter has not met yet is not evidence of failure. The
      // deadline is what stops the loop in every one of those cases.
    }

    // Deadline hit with the job still unresolved. RETRYABLE: a slow queue is
    // a bad minute at the vendor, not a property of this file.
    //
    // Retrying is not free, though. The job we abandoned may well complete
    // afterwards and AssemblyAI will bill it, so a retry pays twice for the
    // same audio and this failure row logs zero cost we cannot see. That is
    // the trade N3.3's attempt cap governs — and the reason its claim lease
    // must exceed this adapter's 20-minute budget rather than race it.
    await this.writeUsage({
      ...ctx,
      opts,
      durationSeconds: opts.durationSecondsHint ?? 0,
      costMicros: 0n,
      latencyMs: Date.now() - ctx.start,
      succeeded: false,
      errorCode: "poll_deadline_exceeded",
      providerTranscriptId: transcriptId,
      pollAttempts: attempts,
    });
    throw new ASRError(
      `AssemblyAIASRClient: transcript ${transcriptId} did not complete within ` +
        `${Math.round(this.overallTimeoutMs / 1000)}s (${attempts} polls).`,
      true,
    );
  }

  /**
   * One HTTP call with the shared failure taxonomy. Every non-2xx and every
   * transport error is classified here — once — so the drain worker never has
   * to read an HTTP status code, and so no throw site can forget to write its
   * ledger row.
   */
  private async request(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    opts: ASRTranscribeOptions,
    ctx: CallContext,
    stage: "upload" | "create" | "poll",
    extra?: { transcriptId?: string; pollAttempts?: number },
  ): Promise<Response> {
    // Never let a single request outlive the whole-call budget.
    const remaining = ctx.deadline - Date.now();
    const effectiveTimeout = Math.max(1, Math.min(timeoutMs, remaining));

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(effectiveTimeout) });
    } catch (err) {
      // Network failure or timeout — no response at all. Retryable; the
      // drain worker's attempt cap is the right place to give up.
      await this.writeUsage({
        model: ctx.model,
        feature: ctx.feature,
        opts,
        durationSeconds: opts.durationSecondsHint ?? 0,
        // Zero: a request that never completed is not a billed minute. If an
        // invoice ever says otherwise, this is the line to revisit.
        costMicros: 0n,
        latencyMs: Date.now() - ctx.start,
        succeeded: false,
        errorCode: `transport_error_${stage}`,
        providerTranscriptId: extra?.transcriptId,
        pollAttempts: extra?.pollAttempts,
      });
      throw new ASRError(
        `AssemblyAIASRClient: ${stage} request failed before a response was received.`,
        true,
        err,
      );
    }

    if (res.ok) return res;

    const body = await safeText(res);
    // 408/429/5xx are transient — the same request can succeed later. Every
    // other 4xx is about the request, the credential or the media itself and
    // will fail identically on retry.
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    await this.writeUsage({
      ...ctx,
      opts,
      durationSeconds: opts.durationSecondsHint ?? 0,
      costMicros: 0n,
      latencyMs: Date.now() - ctx.start,
      succeeded: false,
      errorCode: `http_${res.status}_${stage}`,
      providerTranscriptId: extra?.transcriptId,
      pollAttempts: extra?.pollAttempts,
    });

    const message = `AssemblyAIASRClient: ${stage} HTTP ${res.status} — ${body.slice(0, 500)}`;
    if (retryable) throw new ASRError(message, retryable);
    if (res.status === 401 || res.status === 403) {
      // A bad or revoked key. Non-retryable and deliberately NOT a media
      // error: the file is fine, the deployment is not.
      throw new ASRError(
        `${message} (check ASSEMBLYAI_API_KEY and the ASSEMBLYAI_REGION the key belongs to)`,
        false,
      );
    }
    if (stage === "upload" || res.status === 413 || res.status === 415) {
      // The vendor refused these bytes: too large, or a container it will not
      // transcode. Same bytes, same answer — fail the row now.
      throw new ASRUnsupportedMediaError(message, opts.contentType);
    }
    // A 400/422 on the JSON control plane is a validation bug in this
    // adapter's request, not a transient condition.
    throw new ASRError(message, false);
  }

  private async writeUsage(args: {
    model: string;
    feature: string;
    opts: ASRTranscribeOptions;
    durationSeconds: number;
    costMicros: bigint;
    latencyMs: number;
    succeeded: boolean;
    errorCode?: string;
    providerTranscriptId?: string;
    segmentCount?: number;
    pollAttempts?: number;
  }): Promise<void> {
    await recordAIUsage({
      tenantId: this.tenantId,
      provider: this.provider,
      model: args.model,
      feature: args.feature,
      actorMembershipId: args.opts.actorMembershipId ?? null,
      // BOTH ZERO BY DESIGN. ASR is priced per audio-minute, not per token,
      // so there are no tokens to report — this row is NOT a broken or
      // partially-populated log entry. The billable quantity is
      // metadata.durationSeconds, and cost_micros below is real money
      // derived from it via asr-pricing.ts. Any cost query that assumes
      // cost_micros correlates with tokens will be wrong about this
      // feature; sum cost_micros, never re-derive it from tokens.
      inputTokens: 0,
      outputTokens: 0,
      costMicros: args.costMicros,
      latencyMs: args.latencyMs,
      requestId: args.opts.requestId ?? null,
      succeeded: args.succeeded,
      errorCode: args.errorCode ?? null,
      // Enough to reconcile a line of this ledger against an AssemblyAI
      // invoice without going back to the recording: the transcript id is
      // what their usage export is keyed on, and `endpoint` records which
      // region actually processed the minutes.
      metadata: {
        durationSeconds: args.durationSeconds,
        contentType: args.opts.contentType,
        endpoint: this.baseUrl,
        ...(args.providerTranscriptId
          ? {
              providerTranscriptId: args.providerTranscriptId,
              providerRequestId: args.providerTranscriptId,
            }
          : {}),
        ...(args.segmentCount !== undefined ? { segmentCount: args.segmentCount } : {}),
        ...(args.pollAttempts !== undefined ? { pollAttempts: args.pollAttempts } : {}),
      },
    });
  }
}

/** Per-call state every private step needs; keeps their signatures honest. */
interface CallContext {
  model: string;
  feature: string;
  /** Date.now() at the top of transcribe(), for latency. */
  start: number;
  /** Absolute wall-clock budget for the whole call. */
  deadline: number;
}

/**
 * `utterances` → our segment array.
 *
 * OFFSET UNITS: AssemblyAI reports `start` / `end` in MILLISECONDS on both
 * words and utterances (unlike Deepgram, whose utterances are float
 * seconds), so this is a straight copy with no conversion — the rounding
 * below is defensive only. If a future API version ever switches to seconds
 * a 60-minute interview would come out 3,600ms long, which the
 * monotonic-offset assertions in the N3.1b test would catch immediately.
 *
 * Speaker labels are AssemblyAI's anonymous letters mapped onto the same
 * `speaker_N` vocabulary Deepgram's indices produce — see the header on why
 * this layer cannot honestly say "candidate".
 */
function mapSegments(transcript: AssemblyAITranscript): ASRSegment[] {
  const utterances = transcript.utterances;
  if (utterances && utterances.length > 0) {
    return utterances
      .map((u) => ({
        speaker: normaliseSpeaker(u.speaker),
        startMs: Math.round(u.start ?? 0),
        endMs: Math.round(u.end ?? u.start ?? 0),
        text: (u.text ?? "").trim(),
      }))
      .filter((s) => s.text.length > 0);
  }

  // Defensive only: we always send speaker_labels=true. If diarisation is
  // ever unavailable for a language or model, degrade to a single undiarised
  // segment rather than losing the transcript entirely.
  const text = transcript.text?.trim();
  if (!text) return [];
  return [
    {
      speaker: "speaker_0",
      startMs: 0,
      endMs: Math.round((transcript.audio_duration ?? 0) * 1000),
      text,
    },
  ];
}

/**
 * "A" → speaker_0, "B" → speaker_1, … A 1:1 relabelling of an anonymous
 * label, never an interpretation of it. Anything outside A–Z (a numeric
 * label, or an empty one) is lower-cased and passed through with the same
 * prefix so no information is lost and the value stays a plain string.
 */
function normaliseSpeaker(raw: string | undefined): string {
  const label = (raw ?? "").trim();
  if (label.length === 0) return "speaker_0";
  if (/^[A-Za-z]$/.test(label)) {
    return `speaker_${label.toUpperCase().charCodeAt(0) - 65}`;
  }
  return `speaker_${label.toLowerCase()}`;
}

/**
 * Prefers the transcript-level `text`, which is AssemblyAI's own flattened
 * form of the whole audio, and falls back to joining our segments. Stored
 * rather than recomputed downstream so the summariser prompt is byte-stable
 * across reruns (the reasoning in the 0116 table header).
 */
function flattenTranscript(transcript: AssemblyAITranscript, segments: ASRSegment[]): string {
  const text = transcript.text?.trim();
  if (text) return text;
  return segments.map((s) => s.text).join(" ");
}

/**
 * BCP-47 in, AssemblyAI's `language_code` out: they use underscores and
 * lower case ("en_us"), so a caller passing the standard "en-US" would
 * otherwise get a 400 for a language we do support. Bare "en" passes
 * through unchanged.
 */
function toAssemblyAILanguageCode(language: string): string {
  return language.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Their `error` string is prose, not a code. These are the phrasings that
 * mean "we could not decode your media" rather than "something went wrong
 * our end". Both verdicts are non-retryable, so a miss here only changes the
 * error class the worker records, never whether it retries.
 */
function looksLikeMediaRejection(detail: string): boolean {
  return /transcod|download error|does not appear to contain audio|not able to (?:decode|process)|file (?:is )?(?:empty|corrupt)|unsupported/i.test(
    detail,
  );
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/**
 * A 200 with a body we cannot parse is treated as an empty object rather
 * than a throw: the callers above already handle "the field I needed is
 * missing" and produce a classified ASRError, which is more useful to the
 * worker than a raw SyntaxError.
 */
async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
