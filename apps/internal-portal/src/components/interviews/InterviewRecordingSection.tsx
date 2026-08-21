"use client";

import { useRef, useState } from "react";
import { Button } from "@hireops/ui";
import { Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { InterviewRecordingStatus } from "@hireops/api-types";

/**
 * N3.4a — the recruiter's recording controls for ONE interview round.
 *
 * Three things that belong together and were previously nowhere: whether the
 * candidate consented, whether the recruiter asked for this round to be
 * recorded, and — only when BOTH are true — the upload itself. Splitting them
 * across surfaces would let someone see an upload button and have no idea why
 * it is disabled.
 *
 * WHAT THIS DELIBERATELY DOES NOT SHOW: the transcript, or the notes derived
 * from it. That is N3.4b. This surface's job is to get media into the
 * pipeline and let a recruiter watch the pipeline move.
 *
 * The upload is TWO API CALLS AND ONE DIRECT PUT:
 *   start  → a short-lived signed url the browser PUTs the file to itself
 *   PUT    → straight to storage; a 250MB panel recording never touches the API
 *   complete → the API verifies the object landed and enqueues transcription
 *
 * If the PUT fails, nothing is enqueued and the recording row stays 'pending'
 * — the drain defers pending rows without burning a retry, so an abandoned
 * upload costs nothing and can simply be retried.
 */

const STATUS_LABEL: Record<InterviewRecordingStatus, string> = {
  pending: "Awaiting upload",
  uploaded: "Uploaded — queued for transcription",
  transcribing: "Transcribing…",
  transcribed: "Transcribed",
  failed: "Transcription failed",
};

const STATUS_TONE: Record<InterviewRecordingStatus, "neutral" | "info" | "success" | "error"> = {
  pending: "neutral",
  uploaded: "info",
  transcribing: "info",
  transcribed: "success",
  failed: "error",
};

function fmtBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Why recording is blocked, in the recruiter's terms. The two halves of the
 * gate have completely different fixes — "ask the candidate" vs "flip the
 * toggle" — so a single "not available" would send someone to the wrong
 * place. Mirrors the API's own refusal text.
 */
function blockedReasons(gate: {
  recordingRequested: boolean;
  consent: { permitted: boolean; decision: "granted" | "declined" | "withdrawn" | null };
}): string[] {
  const out: string[] = [];
  if (!gate.recordingRequested) out.push("Recording is not requested for this round.");
  if (!gate.consent.permitted) {
    out.push(
      gate.consent.decision === null
        ? "The candidate has not been asked for recording consent — it is requested on their interview confirmation link."
        : gate.consent.decision === "declined"
          ? "The candidate declined recording."
          : "The candidate withdrew their recording consent.",
    );
  }
  return out;
}

export function InterviewRecordingSection({ interviewId }: { interviewId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState<string | null>(null);

  const state = trpc.getInterviewMediaState.useQuery({ interviewId });
  const setRequested = trpc.setInterviewRecordingRequested.useMutation({
    onSuccess: () => void state.refetch(),
  });
  const start = trpc.startInterviewMediaUpload.useMutation();
  const complete = trpc.completeInterviewMediaUpload.useMutation();

  if (state.isLoading) {
    return <p className="mt-2 text-xs text-neutral-500">Loading recording state…</p>;
  }
  if (!state.data) return null;

  const { gate, recording, maxBytes, allowedContentTypes } = state.data;
  const reasons = blockedReasons(gate);

  async function onUpload() {
    const chosen = file;
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setProgressNote(null);
    try {
      // Browser-side courtesy checks. The API enforces both again — and, on
      // complete, against the object that actually landed rather than what
      // the browser said it was sending.
      if (chosen.size > maxBytes) {
        throw new Error(
          `That file is ${fmtBytes(chosen.size)}, over the ${fmtBytes(maxBytes)} limit.`,
        );
      }
      const declaredType = chosen.type || "application/octet-stream";

      setProgressNote("Authorising upload…");
      const authorised = await start.mutateAsync({
        interviewId,
        contentType: declaredType,
        sizeBytes: chosen.size,
      });

      if (authorised.provider === "local") {
        // The local storage tier mints a `local://` url with no HTTP surface
        // — deliberately un-dereferenceable so a fake url can never be
        // mistaken for a real one. Say so rather than throwing a confusing
        // network error.
        throw new Error(
          "This environment uses the local storage tier, which has no upload endpoint. " +
            "Point STORAGE_PROVIDER at Supabase to upload from the browser.",
        );
      }

      setProgressNote(`Uploading ${fmtBytes(chosen.size)}…`);
      const put = await fetch(authorised.uploadUrl, {
        method: authorised.method,
        // The signed url carries its own credential; the only headers that
        // matter are the content type storage should record and the upsert
        // flag (a re-upload legitimately replaces the object at this key).
        headers: { "content-type": authorised.contentType, "x-upsert": "true" },
        body: chosen,
      });
      if (!put.ok) {
        throw new Error(`Upload failed (${put.status}). Nothing was queued; try again.`);
      }

      setProgressNote("Verifying and queueing transcription…");
      await complete.mutateAsync({ interviewId });
      setProgressNote(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await state.refetch();
    } catch (err) {
      setProgressNote(null);
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50/60 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-neutral-700">Recording</span>
        {gate.canRecord ? (
          <Badge tone="success">Consented &amp; requested</Badge>
        ) : (
          <Badge tone="neutral">Not available</Badge>
        )}
        {recording ? (
          <Badge tone={STATUS_TONE[recording.status]}>{STATUS_LABEL[recording.status]}</Badge>
        ) : null}
        {recording?.mediaPurgedAt ? <Badge tone="neutral">Audio deleted (retention)</Badge> : null}
      </div>

      <label className="mb-2 flex items-center gap-2 text-neutral-700">
        <input
          type="checkbox"
          checked={gate.recordingRequested}
          disabled={setRequested.isPending}
          onChange={(e) => setRequested.mutate({ interviewId, requested: e.currentTarget.checked })}
          className="h-3.5 w-3.5"
        />
        Record this round
      </label>

      {reasons.length > 0 ? (
        <ul className="mb-2 list-disc pl-4 text-neutral-500">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      {recording ? (
        <p className="mb-2 text-neutral-500">
          {recording.mediaType ?? "audio"}
          {fmtBytes(recording.sizeBytes) ? ` · ${fmtBytes(recording.sizeBytes)}` : ""}
          {recording.queueStatus ? ` · queue: ${recording.queueStatus}` : ""}
          {recording.queueError ? ` · ${recording.queueError}` : ""}
        </p>
      ) : null}

      {gate.canRecord ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={allowedContentTypes.join(",")}
            disabled={busy}
            onChange={(e) => {
              setFile(e.currentTarget.files?.[0] ?? null);
              setError(null);
            }}
            className="max-w-[18rem] text-xs text-neutral-600"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!file || busy}
            onClick={() => void onUpload()}
          >
            {busy ? "Working…" : "Upload recording"}
          </Button>
        </div>
      ) : null}

      {progressNote ? <p className="mt-2 text-neutral-500">{progressNote}</p> : null}
      {error ? <p className="mt-2 text-status-error-700">{error}</p> : null}

      <p className="mt-2 text-[11px] text-neutral-400">
        Audio is uploaded straight to storage, transcribed by the notetaker worker, and deleted on
        the retention schedule. The transcript and notes are kept.
      </p>
    </div>
  );
}
