import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordAIUsage } from "../usage-log";
import { computeASRCostMicros, ASR_USAGE_FEATURE } from "../asr-pricing";
import { ASRError } from "./types";
import type { ASRClient, ASRResult, ASRSegment, ASRTranscribeOptions } from "./types";

/**
 * Deterministic ASR for dev + CI. Never touches the network.
 *
 * Two tiers, in order:
 *
 *   1. FIXTURE. sha256(audio bytes + contentType + language + model +
 *      duration hint) → `fixtures/<hash>.json`. Use this when a test needs
 *      an exact transcript — e.g. asserting that the N3.3 summariser
 *      prompt sees specific words.
 *
 *   2. SYNTHESIS. If no fixture exists, derive a plausible multi-speaker
 *      transcript from the same hash.
 *
 * WHY TIER 2 EXISTS AT ALL — LocalAIClient deliberately *throws* on a
 * missing fixture, so that tests can never accidentally assert against
 * "the model said something reasonable". Copying that here would be wrong.
 * A prompt is a string a human wrote and can paste into a fixture file; an
 * audio buffer is not. Requiring a fixture would mean every dev and every
 * N3.3 test that merely needs *a* transcript would first have to hash a
 * binary blob and hand-author a JSON file keyed on that digest. The whole
 * dev loop (upload a recording → see notes appear) would be unusable
 * without a network call, which is the thing the local tier exists to
 * avoid.
 *
 * Synthesis is still fully deterministic — same bytes and same options
 * produce the same transcript, byte for byte — so tests that want
 * stability get it without authoring anything, and tests that want exact
 * content still can via tier 1.
 *
 * COST: logs an ai_usage_logs row with cost_micros = 0 and
 * provider = 'local'. Zero because no vendor call happened and therefore
 * no minute was billed — not because the cost is unknown. The rate the
 * real call *would* have incurred is stamped into metadata
 * (`estimatedCostMicros`) so a dev can eyeball the shape of the COGS line
 * without injecting fake spend into the ledger. That matters: the cost
 * inventory (§9.1) had to discard 320 of 326 `resume_parse` rows because
 * local-mode and seeded rows had polluted them, and this tier is not going
 * to repeat that.
 */

interface ASRFixtureEnvelope {
  segments?: ASRSegment[];
  fullText?: string;
  language?: string | null;
  wordCount?: number;
  durationSeconds?: number;
  latencyMs?: number;
  /** Exercise the failure path of the cost-logging contract. */
  throw?: { message: string; code?: string; retryable?: boolean };
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = resolve(here, "./fixtures");

/** Model id stamped onto provider_model for the local tier. */
export const LOCAL_ASR_MODEL = "local-fixture-asr";

/**
 * ~150 words/minute is a normal conversational rate, so 400ms per word.
 * Used to give synthesised segments durations that look like speech rather
 * than arbitrary numbers.
 */
const MS_PER_WORD = 400;

/** Bound on synthesis so a pathological duration hint cannot blow up memory. */
const MAX_SYNTHETIC_SEGMENTS = 400;

/**
 * Two pools so alternating turns read like an interview rather than one
 * voice split in half. Content is deliberately mundane and non-sensitive —
 * these strings end up in dev databases and screenshots.
 */
const SPEAKER_0_LINES = [
  "Thanks for making the time today. Could you start by walking me through your current role?",
  "What did the team structure look like around you?",
  "How did you decide on that approach rather than the alternative?",
  "Tell me about a time a deployment went badly. What did you do?",
  "Who else had to be convinced before that shipped?",
  "How do you keep the on-call load sustainable for the team?",
  "What would you do differently if you were starting that project again?",
  "Is there anything you would like to ask me about the role?",
];

const SPEAKER_1_LINES = [
  "Sure. I lead a platform team of six engineers, mostly working on the data ingestion side.",
  "We were running a twelve broker Kafka cluster and the retention settings were the recurring problem.",
  "I pushed for the incremental migration because a big bang cutover would have frozen releases for a month.",
  "We lost about forty minutes of processing before the rollback finished, and the postmortem changed our deploy gates.",
  "I wrote the design document first and then walked the two staff engineers through it before opening it wider.",
  "Rotation is weekly and we cap the pager volume, so anything noisy gets fixed or muted within the sprint.",
  "Honestly I would have invested in the test harness earlier rather than after the second incident.",
  "Yes, I would like to understand how the team splits product work against platform work.",
];

export interface LocalASRClientOpts {
  tenantId: string;
  /**
   * Directory of fixture JSON files. Defaults to the package's bundled
   * `asr/fixtures/`, which may not exist — a missing directory simply means
   * every call falls through to synthesis.
   */
  fixtureDir?: string;
}

export class LocalASRClient implements ASRClient {
  readonly provider = "local" as const;
  private readonly tenantId: string;
  private readonly fixtureDir: string;

  constructor(opts: LocalASRClientOpts) {
    this.tenantId = opts.tenantId;
    this.fixtureDir = opts.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  }

  async transcribe(audio: Buffer, opts: ASRTranscribeOptions): Promise<ASRResult> {
    const start = Date.now();
    const hash = hashTranscribeInput(audio, opts);
    const model = opts.model ?? LOCAL_ASR_MODEL;
    const feature = opts.feature ?? ASR_USAGE_FEATURE;
    const fixture = await this.loadFixture(hash);

    if (fixture?.throw) {
      const durationSeconds = fixture.durationSeconds ?? opts.durationSecondsHint ?? 0;
      await this.writeUsage({
        model,
        feature,
        opts,
        durationSeconds,
        latencyMs: Date.now() - start,
        succeeded: false,
        errorCode: fixture.throw.code ?? "fixture_error",
      });
      throw new ASRError(fixture.throw.message, fixture.throw.retryable ?? true);
    }

    const built = fixture?.segments
      ? fromFixture(fixture, opts)
      : synthesise(hash, opts, fixture?.durationSeconds);

    const latencyMs = fixture?.latencyMs ?? Date.now() - start;
    await this.writeUsage({
      model,
      feature,
      opts,
      durationSeconds: built.durationSeconds,
      latencyMs,
      succeeded: true,
    });

    return {
      segments: built.segments,
      fullText: built.fullText,
      language: built.language,
      provider: this.provider,
      providerModel: model,
      wordCount: built.wordCount,
      durationSeconds: built.durationSeconds,
      // Zero because nothing was billed — see the header. Not "unknown".
      costMicros: 0n,
      latencyMs,
    };
  }

  private async loadFixture(hash: string): Promise<ASRFixtureEnvelope | undefined> {
    const path = resolve(this.fixtureDir, `${hash}.json`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as ASRFixtureEnvelope;
    } catch (err) {
      // A missing fixture is the normal case (tier 2). Anything else —
      // malformed JSON, a permissions problem — is a mistake the author
      // wants to hear about rather than silently get synthesis instead.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw new ASRError(
        `LocalASRClient: fixture ${path} exists but could not be read/parsed.`,
        false,
        err,
      );
    }
  }

  private async writeUsage(args: {
    model: string;
    feature: string;
    opts: ASRTranscribeOptions;
    durationSeconds: number;
    latencyMs: number;
    succeeded: boolean;
    errorCode?: string;
  }): Promise<void> {
    await recordAIUsage({
      tenantId: this.tenantId,
      provider: this.provider,
      model: args.model,
      feature: args.feature,
      actorMembershipId: args.opts.actorMembershipId ?? null,
      // Zero because ASR is not token-priced, NOT because the numbers are
      // missing. A reader scanning ai_usage_logs must not read this row as
      // broken. The billable quantity is metadata.durationSeconds.
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0n,
      latencyMs: args.latencyMs,
      requestId: args.opts.requestId ?? null,
      succeeded: args.succeeded,
      errorCode: args.errorCode ?? null,
      metadata: {
        durationSeconds: args.durationSeconds,
        localMode: true,
        // What the same call would have cost against the real rate table.
        // Informational only; it is not summed by any cost surface.
        estimatedCostMicros: Number(computeASRCostMicros("nova-3", args.durationSeconds)),
      },
    });
  }
}

/**
 * Fixture key. Hashes everything that would change what a real provider
 * returned: the audio itself, its container type, and the language/model
 * asked for. Excludes feature / requestId / actorMembershipId, matching
 * hashCompleteOptions' reasoning — those affect the ledger row, not the
 * transcript.
 *
 * Exported so a test can compute the key for the buffer it is about to
 * pass in, the way hashCompleteOptions is used for LLM fixtures.
 */
export function hashTranscribeInput(audio: Buffer, opts: ASRTranscribeOptions): string {
  return createHash("sha256")
    .update(audio)
    .update("␟")
    .update(
      [
        opts.contentType,
        opts.language ?? "",
        opts.model ?? "",
        opts.durationSecondsHint !== undefined ? String(opts.durationSecondsHint) : "",
      ].join("␟"),
    )
    .digest("hex");
}

interface BuiltTranscript {
  segments: ASRSegment[];
  fullText: string;
  language: string | null;
  wordCount: number;
  durationSeconds: number;
}

function fromFixture(fixture: ASRFixtureEnvelope, opts: ASRTranscribeOptions): BuiltTranscript {
  const segments = fixture.segments ?? [];
  const fullText = fixture.fullText ?? flatten(segments);
  return {
    segments,
    fullText,
    language: fixture.language !== undefined ? fixture.language : (opts.language ?? "en"),
    wordCount: fixture.wordCount ?? countWords(fullText),
    durationSeconds:
      fixture.durationSeconds ?? opts.durationSecondsHint ?? lastEndMs(segments) / 1000,
  };
}

/**
 * Builds a transcript from the hash alone.
 *
 * Turns alternate between speaker_0 and speaker_1 — the same anonymous
 * label vocabulary the real adapter emits from Deepgram's diarisation, so
 * anything built against the local tier meets the real shape and not a
 * friendlier fiction. Each turn's duration comes from its word count at a
 * human speaking rate, separated by a small hash-derived gap, which is
 * what guarantees startMs/endMs are strictly increasing across the array.
 *
 * Length tracks the duration hint when there is one, so a 30-minute
 * recording produces a 30-minute-shaped transcript rather than a token one.
 */
function synthesise(
  hash: string,
  opts: ASRTranscribeOptions,
  fixtureDurationSeconds?: number,
): BuiltTranscript {
  const nextByte = byteStream(hash);
  const hintedSeconds = fixtureDurationSeconds ?? opts.durationSecondsHint;
  // No hint: 2–8 minutes, chosen from the hash so it is still deterministic.
  const targetMs = Math.round((hintedSeconds ?? 120 + (nextByte() % 7) * 60) * 1000);

  const segments: ASRSegment[] = [];
  let cursor = 0;
  let turn = 0;
  while (cursor < targetMs && segments.length < MAX_SYNTHETIC_SEGMENTS) {
    const isSpeaker0 = turn % 2 === 0;
    const pool = isSpeaker0 ? SPEAKER_0_LINES : SPEAKER_1_LINES;
    const text = pickLine(pool, nextByte());
    // 200–1,000ms of silence between turns keeps startMs > previous endMs.
    const gapMs = 200 + (nextByte() % 4) * 200;
    const startMs = cursor + gapMs;
    const endMs = startMs + countWords(text) * MS_PER_WORD;
    segments.push({ speaker: isSpeaker0 ? "speaker_0" : "speaker_1", startMs, endMs, text });
    cursor = endMs;
    turn += 1;
  }

  const fullText = flatten(segments);
  return {
    segments,
    fullText,
    language: opts.language ?? "en",
    wordCount: countWords(fullText),
    // When the caller told us the duration, that is the truth about the
    // media and the transcript is what got fitted to it, not the reverse.
    durationSeconds: hintedSeconds ?? cursor / 1000,
  };
}

/**
 * Deterministic byte source. 32 bytes of digest is not always enough for a
 * long recording, so it re-hashes with a counter when exhausted rather than
 * wrapping (wrapping would make long transcripts visibly periodic).
 */
function byteStream(seedHex: string): () => number {
  let buf = Buffer.from(seedHex, "hex");
  let i = 0;
  let round = 0;
  return () => {
    if (i >= buf.length) {
      round += 1;
      buf = createHash("sha256").update(seedHex).update(String(round)).digest();
      i = 0;
    }
    const byte = buf[i] ?? 0;
    i += 1;
    return byte;
  };
}

/**
 * Indexes a line pool. The `?? ""` is unreachable — both pools are
 * non-empty module constants and the index is taken modulo their length —
 * but the index signature is not narrow enough for the compiler to know
 * that, and an empty string is the harmless answer if it ever were.
 */
function pickLine(pool: readonly string[], byte: number): string {
  return pool[byte % pool.length] ?? "";
}

function flatten(segments: ASRSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function lastEndMs(segments: ASRSegment[]): number {
  return segments.length === 0 ? 0 : (segments[segments.length - 1]?.endMs ?? 0);
}
