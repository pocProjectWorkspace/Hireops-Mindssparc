"use client";

import { Button } from "@hireops/ui";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { GetInterviewNotesOutput, TranscriptSegment } from "@hireops/api-types";

/**
 * N3.4b — the notetaker's output for ONE interview round, rendered for a
 * human. Shared by the recruiter's recording panel and the panellist's
 * feedback surface, because both read the same artefacts and neither should
 * describe them differently.
 *
 * READ ONLY. There is no regenerate, no edit, no delete — the procedure behind
 * this has no sibling mutation, and adding one is a separate product decision
 * about who may change what a hiring decision was informed by.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TWO HONESTY REQUIREMENTS THIS COMPONENT EXISTS TO MEET
 * ─────────────────────────────────────────────────────────────────────────
 * 1. THE NOTES ARE LABELLED AS MACHINE-WRITTEN, with the model and the prompt
 *    version on screen. They are a derived artefact; a panellist has to be
 *    able to tell that at a glance rather than infer it. `interview_notes`
 *    carries `model` + `prompt_version` for exactly this, and 0116's header
 *    says so.
 *
 * 2. SPEAKER LABELS ARE ANONYMOUS BY CONSTRUCTION, and the transcript says so
 *    rather than implying otherwise. Every ASR vendor emits speaker_0 /
 *    speaker_1: diarisation groups turns by VOICE and can never know which
 *    voice is the candidate. So the labels are rendered as the vendor gave
 *    them (prettified, never renumbered, never mapped to a name) under a line
 *    explaining what they are. The notes above may attribute roles — that is
 *    the model inferring from content, which is a stated inference; the
 *    transcript claiming the same thing would be a fabrication.
 *
 * AND NO VERDICT, ANYWHERE. There is no score, rating or recommendation on the
 * wire (interviewNotesCardSchema has nowhere to put one), so there is nothing
 * to render here and nothing to pre-fill a scorecard from.
 */

/* ─────────────────────── pipeline state ─────────────────────── */

interface PipelinePhase {
  label: string;
  tone: BadgeTone;
  /** The sentence under the badge. Null when the artefacts speak for themselves. */
  detail: string | null;
  /** True while the pipeline is still expected to move — shows Refresh. */
  inFlight: boolean;
}

/**
 * The honest answer to "why am I not looking at notes?", which is most of what
 * this component renders in practice.
 *
 * Ordering matters. The TRANSCRIPT is checked before `recording.status`
 * because the transcript existing is the fact and the status is a claim about
 * it; and the purge is checked before the in-flight statuses because a purged
 * recording will never transcribe however hopeful its status looks.
 * `mediaPurgedAt` is a separate axis from `status` (0118) — a 31-day-old
 * round is (transcribed, purged), which is retention working, not a failure.
 */
function describePipeline(data: GetInterviewNotesOutput): PipelinePhase {
  const { recording, transcript, notes, notesEnabled } = data;

  if (!recording) {
    return {
      label: "No recording",
      tone: "neutral",
      detail: "Nothing has been recorded for this round.",
      inFlight: false,
    };
  }

  if (transcript) {
    if (notes) return { label: "Notes ready", tone: "success", detail: null, inFlight: false };
    if (!notesEnabled) {
      return {
        label: "Transcript only",
        tone: "neutral",
        detail:
          "AI notes are turned off for this tenant, so the transcript was kept and no notes were generated. An admin can turn them on in Admin → AI settings.",
        inFlight: false,
      };
    }
    return {
      label: "Notes pending",
      tone: "info",
      detail: "The transcript is ready. The notes have not been written yet.",
      inFlight: true,
    };
  }

  if (recording.mediaPurgedAt) {
    return {
      label: "Audio deleted before transcription",
      tone: "neutral",
      detail:
        "The audio was deleted on the retention schedule before it was transcribed, so there is nothing left to transcribe for this round.",
      inFlight: false,
    };
  }

  switch (recording.status) {
    case "pending":
      return {
        label: "Awaiting upload",
        tone: "neutral",
        detail: "The recording has been requested but no audio has been uploaded yet.",
        inFlight: false,
      };
    case "uploaded":
      return {
        label: "Queued for transcription",
        tone: "info",
        detail: "The audio is uploaded. The notetaker worker picks it up on its next pass.",
        inFlight: true,
      };
    case "transcribing":
      return {
        label: "Transcribing",
        tone: "info",
        detail: "Transcription is running.",
        inFlight: true,
      };
    case "failed":
      return {
        label: "Transcription failed",
        tone: "error",
        // Said plainly, and with the queue's own error when it has one: this
        // is terminal, nothing retries it, and a hopeful "processing…" would
        // leave someone waiting for a transcript that is never coming.
        detail: recording.queueError
          ? `Transcription failed and will not retry on its own: ${recording.queueError}`
          : "Transcription failed and will not retry on its own.",
        inFlight: false,
      };
    default:
      // 'transcribed' with no transcript row — a deleted transcript, most
      // likely. Rare, and better named than papered over.
      return {
        label: "Transcript unavailable",
        tone: "neutral",
        detail: "This recording is marked transcribed but no transcript is stored for it.",
        inFlight: false,
      };
  }
}

/* ─────────────────────── formatting ─────────────────────── */

/** mm:ss (or h:mm:ss past an hour) from the start of the media. */
function fmtOffset(startMs: number): string {
  const total = Math.max(0, Math.floor(startMs / 1000));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * `speaker_0` → `Speaker 0`. Cosmetic ONLY — the number is preserved and never
 * renumbered or mapped to a person, because the label's whole meaning is "the
 * vendor heard these turns as one voice" and nothing more. Anything it does
 * not recognise goes through verbatim.
 */
function fmtSpeaker(label: string): string {
  const m = /^speaker[_-](\d+)$/i.exec(label);
  return m ? `Speaker ${m[1]}` : label;
}

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/* ─────────────────────── component ─────────────────────── */

export function InterviewNotesView({ interviewId }: { interviewId: string }) {
  const query = trpc.getInterviewNotes.useQuery({ interviewId });

  if (query.isLoading) {
    return <p className="text-xs text-neutral-500">Loading transcript and notes…</p>;
  }
  if (query.error) {
    return <p className="text-xs text-status-error-700">{query.error.message}</p>;
  }
  if (!query.data) return null;

  const data = query.data;
  const phase = describePipeline(data);
  const { transcript, notes, recording } = data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-neutral-700">Transcript &amp; notes</span>
        <Badge tone={phase.tone}>{phase.label}</Badge>
        {/* The purge is its own axis — shown NEXT TO the phase, never instead
            of it, so "audio gone, transcript kept" reads as the normal
            retention outcome it is. */}
        {recording?.mediaPurgedAt && transcript ? (
          <Badge tone="neutral">Audio deleted per retention policy · transcript kept</Badge>
        ) : null}
        {phase.inFlight ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Checking…" : "Refresh"}
          </Button>
        ) : null}
      </div>

      {phase.detail ? <p className="text-xs text-neutral-500">{phase.detail}</p> : null}

      {notes ? <NotesBlock notes={notes} /> : null}
      {transcript ? <TranscriptBlock transcript={transcript} /> : null}
    </div>
  );
}

/* ─────────────────────── notes ─────────────────────── */

function NotesBlock({ notes }: { notes: NonNullable<GetInterviewNotesOutput["notes"]> }) {
  const generated = fmtWhen(notes.generatedAt);

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      {/* THE PROVENANCE LINE. First thing in the block, before a word of the
          summary: these are machine-written notes and the reader is told so
          with the model and prompt revision that produced them. */}
      <div className="mb-2 border-b border-neutral-100 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">AI-generated</Badge>
          <span className="text-[11px] text-neutral-500">
            Summarised from the transcript
            {notes.model ? ` · ${notes.model}` : ""}
            {notes.promptVersion ? ` · prompt ${notes.promptVersion}` : ""}
            {generated ? ` · ${generated}` : ""}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-neutral-400">
          A machine summary of what was said. It carries no score, rating or recommendation — the
          assessment is yours. Check anything that matters against the transcript below.
        </p>
      </div>

      {notes.summary ? (
        <div className="mb-3">
          <NotesHeading>Summary</NotesHeading>
          <p className="whitespace-pre-wrap text-sm text-neutral-800">{notes.summary}</p>
        </div>
      ) : null}

      <NotesList title="Key points" items={notes.keyPoints} />
      <NotesList title="Topics covered" items={notes.topicsCovered} />
      <NotesList title="Questions asked" items={notes.questionsAsked} />
      <NotesList title="Suggested follow-ups" items={notes.followUps} />
    </div>
  );
}

function NotesHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </p>
  );
}

/** An empty section is simply absent — a heading over nothing says nothing. */
function NotesList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3 last:mb-0">
      <NotesHeading>{title}</NotesHeading>
      <ul className="list-disc space-y-0.5 pl-4 text-sm text-neutral-800">
        {items.map((item, i) => (
          <li key={`${i}-${item.slice(0, 24)}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────── transcript ─────────────────────── */

function TranscriptBlock({
  transcript,
}: {
  transcript: NonNullable<GetInterviewNotesOutput["transcript"]>;
}) {
  const segments: TranscriptSegment[] = transcript.segments;

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <NotesHeading>Transcript</NotesHeading>
      </div>
      <p className="mb-2 text-[11px] text-neutral-400">
        {transcript.provider ? `Transcribed by ${transcript.provider}` : "Machine transcription"}
        {transcript.providerModel ? ` · ${transcript.providerModel}` : ""}
        {transcript.language ? ` · ${transcript.language}` : ""}
        {transcript.wordCount !== null ? ` · ${transcript.wordCount} words` : ""}
      </p>

      {segments.length > 0 ? (
        <>
          {/* WHY THE LABELS ARE WHAT THEY ARE. Cheaper than a label that
              quietly misleads: nothing in the pipeline knows which voice is
              the candidate, so the surface must not imply it does. */}
          <p className="mb-2 rounded bg-neutral-50 p-2 text-[11px] text-neutral-500">
            Speaker labels come from the transcription vendor&apos;s voice separation. They group
            turns by voice only — no one has identified which speaker is the candidate, and the
            numbering is arbitrary.
          </p>
          <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
            {segments.map((seg, i) => (
              <div key={`${i}-${seg.startMs}`} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-[11px] text-neutral-400">
                  {fmtOffset(seg.startMs)}
                </span>
                <div className="min-w-0">
                  <span className="mr-1 text-[11px] font-semibold text-neutral-600">
                    {fmtSpeaker(seg.speaker)}
                  </span>
                  <span className="text-sm text-neutral-800">{seg.text}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : transcript.fullText.trim().length > 0 ? (
        <>
          {/* No turns: either the vendor returned text without diarisation, or
              the stored blob did not validate. Either way the reader gets the
              text and is told the speakers could not be separated, rather than
              a plausible-looking dialogue nobody produced. */}
          <p className="mb-2 rounded bg-neutral-50 p-2 text-[11px] text-neutral-500">
            The transcription vendor did not separate speakers for this recording, so the text below
            is unattributed.
          </p>
          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap pr-1 text-sm text-neutral-800">
            {transcript.fullText}
          </div>
        </>
      ) : (
        <p className="text-xs text-neutral-500">
          The recording contains no speech — the transcript is empty.
        </p>
      )}
    </div>
  );
}
