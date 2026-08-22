/**
 * N4.3b — the browser half of the cumulative-upload contract.
 *
 * `apps/api/src/lib/ai-interview-session.ts` states the rule the server
 * enforces: ONE MediaRecorder runs for the WHOLE round, and at each answer
 * boundary the browser uploads the blob of EVERYTHING RECORDED SO FAR to the
 * SAME storage key. Each checkpoint is a complete, self-contained media file;
 * the last one is the round. Per-answer boundaries are reported as
 * millisecond offsets into that single timeline.
 *
 * WHY THE OBVIOUS THING IS WRONG. Uploading one object per answer and
 * concatenating them server-side does not work: a WebM/Matroska file is an
 * EBML header followed by one Segment, so appending a second complete file
 * produces a stream whose demuxer reads the first answer and stops — silently.
 * The transcript would be one answer long and a recruiter would read that as a
 * fact about the CANDIDATE. Accumulating every chunk since `start()` and
 * building the blob from all of them is what makes each checkpoint valid,
 * because chunk zero carries the header.
 *
 * THE SERVER DOES NOT TRUST US, AND SHOULD NOT. `recordAnswer` refuses a
 * checkpoint whose object SHRANK, because a shrinking object is the signature
 * of a browser that uploaded only the latest answer over the top of the round.
 * That refusal is the backstop for this file being wrong; nothing here should
 * be relied on to be the only guard.
 *
 * Extracted from the client component (the same reason
 * ../confirm/[token]/recording-consent-request.ts is extracted): the mime
 * negotiation and the resume rule are the two decisions with real
 * consequences, and they are testable only if they are not inside a component.
 */

/**
 * MediaRecorder mime candidates, best first.
 *
 * Chrome/Edge/Firefox give WebM/Opus; Safari gives MP4/AAC. Both containers
 * are in the API's ALLOWED_AUDIO_TYPES, and the API normalises away the
 * `;codecs=` parameter, so the codec suffix is ours to ask for and never
 * something the server has to understand.
 */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

/** `audio/webm;codecs=opus` → `audio/webm`, matching the API's normaliser. */
export function baseContentType(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The first candidate this browser can record AND the API will accept.
 *
 * Both halves matter. A browser-supported type the API rejects fails at the
 * first checkpoint, a whole answer in — after the candidate has spoken it.
 * Checking the served `allowedContentTypes` up front means the round falls
 * back to typing BEFORE anyone talks to a microphone for nothing.
 */
export function pickRecorderMimeType(
  allowedContentTypes: readonly string[],
  isTypeSupported: (mime: string) => boolean,
): string | null {
  const allowed = new Set(allowedContentTypes.map((t) => baseContentType(t)));
  for (const candidate of MIME_CANDIDATES) {
    if (isTypeSupported(candidate) && allowed.has(baseContentType(candidate))) return candidate;
  }
  return null;
}

/**
 * May this page instance record voice?
 *
 * THE RESUME RULE, and it is a real constraint rather than caution. The
 * cumulative object lives only in this page's memory: reload, and the chunks
 * from the earlier answers are gone. Recording from that point produces an
 * object SHORTER than the one already in storage, which is exactly what the
 * server refuses as `media_shrank` — correctly, because accepting it would
 * destroy the earlier answers.
 *
 * So a session resumed part-way finishes in typed mode. The alternative —
 * offering a microphone button that is guaranteed to be refused after the
 * candidate has spoken their answer — is worse than saying so up front.
 *
 * A round resumed at zero answers is unaffected: nothing has been uploaded,
 * so there is nothing to shrink.
 */
export function voiceAvailability(input: {
  answeredCount: number;
  recorderStarted: boolean;
  mimeType: string | null;
}): { available: boolean; reason: string | null } {
  if (input.mimeType === null) {
    return {
      available: false,
      reason: "This browser can't record audio in a format we accept, so please type your answers.",
    };
  }
  if (input.answeredCount > 0 && !input.recorderStarted) {
    return {
      available: false,
      reason:
        "You've already answered part of this round, and the recording from earlier answers " +
        "isn't held by this page. Please type the rest of your answers so nothing you " +
        "already said is lost.",
    };
  }
  return { available: true, reason: null };
}

export interface RoundRecorder {
  /** The mime the recorder is actually producing, e.g. `audio/webm;codecs=opus`. */
  readonly mimeType: string;
  /** Milliseconds since the recorder started — the round's single timeline. */
  elapsedMs(): number;
  /**
   * Flush the encoder and return the whole round so far as one valid file.
   * Called at every answer boundary; the object it produces only ever grows.
   */
  checkpoint(): Promise<Blob>;
  /** Stop the recorder and release the microphone. Idempotent. */
  stop(): void;
}

/**
 * Start the round's single recorder.
 *
 * `start(1000)` rather than `start()` so chunks arrive during the round
 * instead of only at stop: a candidate who closes the tab mid-round then still
 * leaves behind the answers already checkpointed, and `requestData()` at each
 * boundary has less to flush.
 */
export async function startRoundRecorder(mimeType: string): Promise<RoundRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    // Zero-byte chunks are normal on some flushes and would add nothing but a
    // wasted Blob part to every subsequent checkpoint.
    if (event.data.size > 0) chunks.push(event.data);
  });
  const startedAt = performance.now();
  recorder.start(1000);

  let stopped = false;
  return {
    mimeType,
    elapsedMs: () => Math.max(0, Math.round(performance.now() - startedAt)),
    async checkpoint() {
      // requestData() fires 'dataavailable' synchronously-ish but not
      // synchronously; waiting for the event is what makes the checkpoint
      // include the answer that just finished rather than truncating it.
      if (recorder.state === "recording") {
        await new Promise<void>((resolve) => {
          recorder.addEventListener("dataavailable", () => resolve(), { once: true });
          recorder.requestData();
        });
      }
      return new Blob(chunks, { type: mimeType });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (recorder.state !== "inactive") recorder.stop();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
