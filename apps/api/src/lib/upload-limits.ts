/**
 * Upload size + media-type limits (N3.2).
 *
 * These were two copies of `const MAX_BYTES = 10 * 1024 * 1024` — one in
 * routes/upload.ts (resumes), one in lib/document-upload.ts (onboarding /
 * candidate documents). The notetaker needs a much larger ceiling for
 * interview audio, and the obvious-but-wrong move is to raise the shared
 * number.
 *
 * WHY TWO CAPS, NOT ONE BIGGER CAP. A 250MB CV is never legitimate. The
 * 10MB document cap is a real guard: it bounds what an unauthenticated
 * apply-form POST can push into storage and into the parser behind it.
 * Widening it so audio fits would delete that guard for every document
 * path in the platform in exchange for a feature neither path serves. So
 * the media ceiling is a separate constant that only media routes read,
 * and MAX_DOCUMENT_BYTES stays exactly where it was.
 */

/**
 * Resume / onboarding-document ceiling. UNCHANGED at 10MB — real CVs are
 * usually under 1MB, but image-heavy design and product portfolios
 * routinely pass 5MB, and ID documents are phone photos.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/**
 * Interview-media ceiling, in bytes. The arithmetic, so the next person can
 * re-derive it rather than guess:
 *
 *   bytes = bitrate_bits_per_second × seconds ÷ 8
 *
 *   - MediaRecorder (N3.4, Opus in WebM, mono, ~64 kbps)
 *       60 min → 64,000 × 3600 ÷ 8 ≈  28 MB
 *   - Teams / Zoom / Meet audio export (AAC or MP3, ~128 kbps)
 *       60 min → 128,000 × 3600 ÷ 8 ≈  58 MB   ← the "~60MB hour"
 *      120 min →                     ≈ 115 MB
 *   - WAV, 16-bit mono 16 kHz (256 kbps — what ASR tooling emits)
 *       60 min →                     ≈ 115 MB
 *
 * 250MB clears a two-hour panel at broadcast-ish bitrate with roughly 2×
 * headroom, and still refuses the two shapes we do not want: 16-bit stereo
 * 44.1 kHz WAV (≈ 635MB/hour — send us a compressed export instead) and a
 * whole video file renamed to .m4a. It is not a storage-cost limit; it is a
 * "this is not an interview recording" limit.
 *
 * Override with MEDIA_MAX_UPLOAD_BYTES when a tenant genuinely records long
 * panels uncompressed.
 */
export const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024;

/**
 * Read at call time rather than at module load, so a test (or a deploy that
 * sets the var after the module graph is warm) sees the current value.
 * Garbage or non-positive input falls back to the default: a typo'd env var
 * must not silently disable the cap.
 */
export function maxMediaBytes(): number {
  const raw = process.env.MEDIA_MAX_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_MEDIA_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_MEDIA_BYTES;
  return Math.floor(parsed);
}

/**
 * Accepted interview-audio content types, in ONE place — the browser
 * upload (N3.4), the vendor-webhook ingest and the ASR call all check the
 * same set, and a MIME list that drifts between them produces media that
 * uploads fine and then fails to transcribe.
 *
 * Why each entry is here:
 *   - audio/webm            MediaRecorder's default in Chrome/Edge (Opus)
 *   - audio/ogg             MediaRecorder's default in Firefox (Opus)
 *   - audio/mp4, audio/m4a,
 *     audio/x-m4a           AAC exports; the correct type is audio/mp4 but
 *                           Teams/Zoom tooling and browsers disagree, and
 *                           the .m4a variants are what actually arrives
 *   - audio/mpeg, audio/mp3 MP3 exports; audio/mp3 is non-standard but
 *                           common enough that rejecting it is a support
 *                           ticket, not a safety measure
 *   - audio/wav, audio/x-wav,
 *     audio/wave            uncompressed, from ASR-oriented tooling
 *
 * Every one of these is a container Deepgram accepts (see packages/
 * ai-client/src/asr/deepgram.ts) — the point of the list is that we reject
 * media at upload time rather than after we have stored it and burned a
 * drain attempt on it.
 */
export const ALLOWED_AUDIO_TYPES: ReadonlySet<string> = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

/**
 * MediaRecorder reports its type with codec parameters attached —
 * `audio/webm;codecs=opus` — and a naive Set.has() on that string rejects
 * the platform's own capture path. Strip parameters, trim, lowercase.
 */
export function normaliseMediaContentType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

export function isAllowedAudioType(contentType: string): boolean {
  return ALLOWED_AUDIO_TYPES.has(normaliseMediaContentType(contentType));
}
