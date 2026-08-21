import { recordAIUsage } from "../usage-log";
import { computeASRCostMicros, ASR_USAGE_FEATURE } from "../asr-pricing";
import { ASRError, ASRUnsupportedMediaError } from "./types";
import type { ASRClient, ASRResult, ASRSegment, ASRTranscribeOptions } from "./types";

/**
 * Deepgram pre-recorded transcription over plain `fetch`.
 *
 * WHY REST AND NOT @deepgram/sdk
 * ------------------------------
 * Three reasons, in order of weight:
 *
 *  1. The vendor is still an open commercial decision
 *     (ai-interview-build-plan.md §8, decision 3 — Deepgram vs Whisper-via-API
 *     vs the LLM provider's own audio path). A REST adapter keeps the swap
 *     to this one file behind the ASRClient interface. An SDK spreads its
 *     types through the call sites and makes the swap a refactor.
 *  2. It is literally one HTTP POST: audio bytes in the body, JSON out.
 *     The SDK's value is streaming, live websockets and project
 *     management — none of which the batch path uses.
 *  3. Dependency cost. The LLM adapters take their SDKs as *optional peer*
 *     deps precisely so the package stays installable without them; adding
 *     a hard dependency for one fetch call would be the heaviest thing in
 *     this package for the least reason.
 *
 * The credential is a PLATFORM key from the environment, not a per-tenant
 * BYO credential like `ai_anthropic` / `ai_openai`. That is not an
 * oversight — ASR bills per audio-minute against our account whether or
 * not the tenant brings their own LLM key, which is exactly why every call
 * here writes a cost row (COMMERCIAL-sizing-and-hosting-cost-model.md §5.3).
 * If a tenant ever demands BYO ASR, this is where the credential lookup
 * goes, following factory.ts's integration_credentials pattern.
 *
 * Request shape: `diarize=true` (so `speaker` is populated — the
 * `interview_transcripts.segments` contract requires it), `utterances=true`
 * (Deepgram's own turn segmentation, which maps straight onto our segment
 * array), plus `punctuate` + `smart_format` so `full_text` is readable
 * enough to hand to the summariser prompt.
 *
 * NOTE ON SPEAKER LABELS: Deepgram returns anonymous integer speaker
 * indices (0, 1, 2 …). It cannot know which voice is the candidate, so we
 * emit `speaker_0` / `speaker_1` and leave role attribution to a
 * human-in-the-loop step downstream. The seed row in
 * notetaker-01-schema.test.ts uses semantic labels ("panellist",
 * "candidate"); those are a *re-labelling* of this output, not something
 * the ASR layer can produce honestly.
 */

const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1/listen";

/** Nova-3 English. Priced in asr-pricing.ts. */
export const DEFAULT_DEEPGRAM_MODEL = "nova-3";

/**
 * Batch transcription of a long interview is minutes of wall clock, not
 * seconds — Deepgram holds the connection until the whole file is done.
 * Five minutes is generous for a 60-minute recording and still bounded, so
 * a hung request cannot pin a drain worker slot forever.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface DeepgramASRClientOpts {
  tenantId: string;
  apiKey: string;
  /** Override for tests / self-hosted Deepgram. Defaults to the public API. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * The subset of Deepgram's response we depend on. Every field is optional
 * on purpose: this is untrusted JSON off the wire, and a missing field
 * should degrade the transcript rather than throw a TypeError three frames
 * deep in a worker.
 */
interface DeepgramAlternative {
  transcript?: string;
}

interface DeepgramChannel {
  detected_language?: string;
  alternatives?: DeepgramAlternative[];
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: number;
}

interface DeepgramResponse {
  metadata?: {
    request_id?: string;
    duration?: number;
    models?: string[];
    model_info?: Record<string, { name?: string; version?: string }>;
  };
  results?: {
    channels?: DeepgramChannel[];
    utterances?: DeepgramUtterance[];
  };
}

export class DeepgramASRClient implements ASRClient {
  readonly provider = "deepgram" as const;
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: DeepgramASRClientOpts) {
    this.tenantId = opts.tenantId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEEPGRAM_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult> {
    const start = Date.now();
    const model = opts.model ?? DEFAULT_DEEPGRAM_MODEL;
    const feature = opts.feature ?? ASR_USAGE_FEATURE;
    const language = opts.language ?? "en";

    if (audio.length === 0) {
      // Fail before spending a request; an empty body is a 400 every time.
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
        "DeepgramASRClient: refusing to transcribe a zero-byte audio buffer.",
        opts.contentType,
      );
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set("model", model);
    url.searchParams.set("language", language);
    // Required by the interview_transcripts.segments contract.
    url.searchParams.set("diarize", "true");
    url.searchParams.set("utterances", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("smart_format", "true");

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": opts.contentType,
        },
        // Buffer is a Uint8Array; a view over the same memory avoids
        // copying the whole recording a second time.
        body: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network failure or timeout — no response at all. Retryable: the
      // drain worker's attempt cap is the right place to give up.
      await this.writeUsage({
        model,
        feature,
        opts,
        durationSeconds: opts.durationSecondsHint ?? 0,
        // Zero: a request that never completed is not a billed minute.
        // If an invoice ever says otherwise, this is the line to revisit.
        costMicros: 0n,
        latencyMs: Date.now() - start,
        succeeded: false,
        errorCode: "transport_error",
      });
      throw new ASRError(
        `DeepgramASRClient: request failed before a response was received.`,
        true,
        err,
      );
    }

    if (!res.ok) {
      const body = await safeText(res);
      // 4xx other than 429 is about the request or the media itself and
      // will fail identically on retry; 429 and 5xx are transient.
      const retryable = res.status === 429 || res.status >= 500;
      await this.writeUsage({
        model,
        feature,
        opts,
        durationSeconds: opts.durationSecondsHint ?? 0,
        costMicros: 0n,
        latencyMs: Date.now() - start,
        succeeded: false,
        errorCode: `http_${res.status}`,
      });
      const message = `DeepgramASRClient: HTTP ${res.status} — ${body.slice(0, 500)}`;
      if (!retryable && res.status >= 400 && res.status < 500) {
        throw new ASRUnsupportedMediaError(message, opts.contentType);
      }
      throw new ASRError(message, retryable);
    }

    const json = (await res.json()) as DeepgramResponse;
    const latencyMs = Date.now() - start;

    const segments = mapSegments(json);
    const fullText = flattenTranscript(json, segments);
    // Deepgram measures the media itself; that is the quantity it bills on,
    // so it wins over the caller's hint whenever it is present.
    const durationSeconds = json.metadata?.duration ?? opts.durationSecondsHint ?? 0;
    const costMicros = computeASRCostMicros(model, durationSeconds);

    if (segments.length === 0) {
      // Silence, or audio the model could not resolve into words. Not an
      // error — a genuinely silent recording is a real outcome — but the
      // caller must still be charged for the minutes, so the log row is
      // written the same way and the empty result is returned.
      console.warn(
        `[ai-client] Deepgram returned no utterances for a ${durationSeconds}s recording ` +
          `(request_id=${json.metadata?.request_id ?? "unknown"}).`,
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
      providerRequestId: json.metadata?.request_id,
      segmentCount: segments.length,
    });

    return {
      segments,
      fullText,
      language: json.results?.channels?.[0]?.detected_language ?? language,
      provider: this.provider,
      providerModel: resolveProviderModel(json, model),
      wordCount: countWords(fullText),
      durationSeconds,
      costMicros,
      latencyMs,
    };
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
    providerRequestId?: string;
    segmentCount?: number;
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
      // Enough to reconcile a line of this ledger against a Deepgram
      // invoice without going back to the recording.
      metadata: {
        durationSeconds: args.durationSeconds,
        contentType: args.opts.contentType,
        ...(args.providerRequestId ? { providerRequestId: args.providerRequestId } : {}),
        ...(args.segmentCount !== undefined ? { segmentCount: args.segmentCount } : {}),
      },
    });
  }
}

/**
 * `utterances` → our segment array. Deepgram's utterance is already a
 * speaker-attributed turn with float second offsets, which is the same
 * concept as our segment; the mapping is unit conversion plus the
 * `speaker_N` labelling described in the header.
 */
function mapSegments(json: DeepgramResponse): ASRSegment[] {
  const utterances = json.results?.utterances;
  if (utterances && utterances.length > 0) {
    return utterances
      .map((u) => ({
        speaker: `speaker_${u.speaker ?? 0}`,
        startMs: Math.round((u.start ?? 0) * 1000),
        endMs: Math.round((u.end ?? u.start ?? 0) * 1000),
        text: (u.transcript ?? "").trim(),
      }))
      .filter((s) => s.text.length > 0);
  }

  // Defensive only: we always send utterances=true. If a future API
  // version or a self-hosted deployment drops them, degrade to a single
  // undiarised segment rather than losing the transcript entirely.
  const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (!transcript) return [];
  return [
    {
      speaker: "speaker_0",
      startMs: 0,
      endMs: Math.round((json.metadata?.duration ?? 0) * 1000),
      text: transcript,
    },
  ];
}

/**
 * Prefers the channel-level transcript, which is Deepgram's own flattened
 * form of the whole audio, and falls back to joining our segments. Stored
 * rather than recomputed downstream so the summariser prompt is
 * byte-stable across reruns (the reasoning in the 0116 table header).
 */
function flattenTranscript(json: DeepgramResponse, segments: ASRSegment[]): string {
  const channelTranscript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (channelTranscript) return channelTranscript;
  return segments.map((s) => s.text).join(" ");
}

/**
 * Deepgram echoes the exact model it ran (including its version) in
 * metadata.models. Recording the resolved id rather than the id we
 * requested is the point of provider_model: "nova-3" today may resolve to a
 * different build in six months, and a scorecard dispute needs to know
 * which one produced the words.
 */
function resolveProviderModel(json: DeepgramResponse, requested: string): string {
  const uuid = json.metadata?.models?.[0];
  const info = uuid ? json.metadata?.model_info?.[uuid] : undefined;
  if (info?.name && info.version) return `${info.name}-${info.version}`;
  if (info?.name) return info.name;
  return requested;
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
