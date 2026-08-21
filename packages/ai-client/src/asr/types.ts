/**
 * Pluggable speech-to-text (ASR) interface — N3.1.
 *
 * Same three-tier pattern as @hireops/ai-client's AIClient and the api's
 * StorageClient:
 *   - AssemblyAIASRClient — production default (N3.1b), async: upload →
 *                           create job → poll, all over fetch
 *   - DeepgramASRClient   — the other real vendor, one synchronous REST call.
 *                           Kept and reachable via ASR_PROVIDER=deepgram;
 *                           two live implementations is what proves this
 *                           interface is an abstraction and not a wrapper
 *   - LocalASRClient      — deterministic, fixture/hash-driven, tests + dev
 *   - getASRClient()      — factory dispatched by env
 *
 * ASRResult is deliberately shaped 1:1 onto the columns
 * `interview_transcripts` already has (migration 0116) so the N3.3 drain
 * worker can INSERT it without a translation layer:
 *
 *     segments      → segments        (jsonb array of the same objects)
 *     fullText      → full_text
 *     language      → language
 *     provider      → provider
 *     providerModel → provider_model
 *     wordCount     → word_count
 *
 * `durationSeconds`, `costMicros` and `latencyMs` are NOT transcript
 * columns. They are provenance of the *call*, carried on the result for the
 * same reason AICompleteResult carries them: the caller may want to stamp
 * them onto an outbox row or an ops surface, and re-deriving cost at the
 * call site would duplicate the rate table. `durationSeconds` in particular
 * is the billing unit — see asr-pricing.ts.
 */

/**
 * One diarised turn. Exactly the object stored in
 * `interview_transcripts.segments` — do not add fields here without
 * checking the api-types zod schema that validates that jsonb column,
 * because the schema's whole point (see the table header) is that a
 * provider swap needs no migration.
 *
 * `speaker` is a provider-assigned label, NOT a role. Diarisation tells you
 * "these turns came from the same voice", never "this voice is the
 * candidate". Every adapter emits `speaker_0`, `speaker_1`, … whatever the
 * vendor's own label vocabulary is (Deepgram integer indices, AssemblyAI
 * letters), and mapping a label to a panellist or candidate is a downstream
 * (N3.3/N3.4) concern with a human in the loop.
 */
export interface ASRSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export type ASRProvider = "assemblyai" | "deepgram" | "local";

export interface ASRTranscribeOptions {
  /**
   * MIME type of the audio buffer (e.g. "audio/webm", "audio/mpeg",
   * "audio/wav"). Required rather than sniffed: Deepgram takes it as the
   * request Content-Type, and guessing wrong produces a confusing 400
   * several layers away from the caller who actually knew the answer.
   */
  contentType: string;

  /**
   * BCP-47 language hint. Defaults to "en". Passed to the provider as a
   * hint, not an assertion — the returned `language` is what the provider
   * actually detected/used and is what gets stored.
   */
  language?: string;

  /** Provider model id. Defaults per adapter; see each adapter's header. */
  model?: string;

  /**
   * Known duration of the media, from `interview_recordings.duration_seconds`
   * where the caller has it.
   *
   * Deepgram returns its own measured duration and that wins (it is what
   * the vendor bills on). The hint matters for two other cases: the local
   * tier, which has no audio to measure and uses it to synthesise a
   * proportionally-sized transcript, and the failure path, where we want a
   * duration to reason about even though nothing came back.
   */
  durationSecondsHint?: number;

  /**
   * ai_usage_logs.feature. Defaults to ASR_USAGE_FEATURE. Overridable so
   * the N4 AI-interview path can attribute its own minutes separately from
   * the notetaker's without a second adapter.
   */
  feature?: string;

  /** Correlation id → ai_usage_logs.request_id. */
  requestId?: string | null;
  /** Actor → ai_usage_logs.actor_membership_id. Usually null (worker-driven). */
  actorMembershipId?: string | null;
}

export interface ASRResult {
  /** → interview_transcripts.segments (jsonb). */
  segments: ASRSegment[];
  /** → interview_transcripts.full_text. The form the summariser prompt consumes. */
  fullText: string;
  /** → interview_transcripts.language. Null when the provider reports none. */
  language: string | null;
  /** → interview_transcripts.provider. */
  provider: ASRProvider;
  /** → interview_transcripts.provider_model. */
  providerModel: string;
  /** → interview_transcripts.word_count. */
  wordCount: number;

  /**
   * Billed audio length. Not a transcript column — this is the unit ASR is
   * priced in (see asr-pricing.ts), carried out so callers don't recompute it.
   */
  durationSeconds: number;
  /** Cost in integer micros (1 USD = 1,000,000), as written to ai_usage_logs. */
  costMicros: bigint;
  latencyMs: number;
}

export interface ASRClient {
  readonly provider: ASRProvider;

  /**
   * Transcribes an audio buffer. Writes exactly one ai_usage_logs row per
   * call — success or failure — because ASR minutes are a real COGS line
   * that no other ledger captures (see asr-pricing.ts).
   *
   * Throws ASRError on transport/provider failure and
   * ASRUnsupportedMediaError when the provider rejects the media itself.
   */
  transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult>;
}

/**
 * Transport / provider failure.
 *
 * Follows the StorageError precedent (message + underlying) with one
 * addition: `retryable`. The N3.3 drain worker has an attempt cap and needs
 * to tell "Deepgram 503, try again in a minute" apart from "this file will
 * never transcribe", and inspecting HTTP status codes at the call site
 * would leak the vendor's error taxonomy into the worker.
 */
export class ASRError extends Error {
  constructor(
    message: string,
    /** No default: every throw site must decide whether a retry can help. */
    public readonly retryable: boolean,
    public readonly underlying?: unknown,
  ) {
    super(message);
    this.name = "ASRError";
  }
}

/**
 * The provider rejected the media (unsupported codec, corrupt container,
 * empty file). Never retryable — the same bytes will fail the same way, so
 * the worker should fail the outbox row now rather than burn its attempt cap.
 */
export class ASRUnsupportedMediaError extends ASRError {
  constructor(
    message: string,
    public readonly contentType: string,
    underlying?: unknown,
  ) {
    super(message, false, underlying);
    this.name = "ASRUnsupportedMediaError";
  }
}
