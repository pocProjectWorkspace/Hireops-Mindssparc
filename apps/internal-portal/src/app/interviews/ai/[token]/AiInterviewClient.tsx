"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import {
  baseContentType,
  pickRecorderMimeType,
  startRoundRecorder,
  voiceAvailability,
  type RoundRecorder,
} from "./round-recorder";

/**
 * N4.3b — the AI first round as the candidate walks it.
 *
 * N4.3a built five unauthenticated routes and no UI. This is the UI, and it
 * adds no rules of its own: every refusal, every piece of copy and the whole
 * question order come from the server. The client's only real jobs are the
 * microphone and the cumulative-upload contract, both of which live in
 * ./round-recorder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE QUESTION, AND ONLY THE ONE THEY ARE ON
 * ─────────────────────────────────────────────────────────────────────────
 * There is no local question array to walk. `currentQuestion` is whatever the
 * last response said it was, and the round advances because the SERVER
 * advanced it. That is not deference for its own sake: a candidate who can
 * read ahead is being interviewed under different conditions from one who
 * cannot, so the remaining questions never leave the API process. Fetching
 * "the next question" is therefore the same call as recording the answer —
 * every write returns the new view.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DISCLOSURE IS RENDERED, NEVER AUTHORED
 * ─────────────────────────────────────────────────────────────────────────
 * `disclosure` arrives with the version the consent row is stamped under, so
 * the wording a candidate saw is recoverable from what they agreed to. Nothing
 * here retypes it, shortens it or reorders it — including the decline copy,
 * which is served for the same reason. (It is flagged as awaiting legal
 * review; rendering it as served is the point of serving it.)
 *
 * NOTHING IS PRE-SELECTED and the two answers render identically, the same
 * rule the interview-confirm page holds: a pre-ticked default would make every
 * stored consent row worthless.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TYPING IS A FIRST-CLASS ANSWER, NOT A FAILURE PATH
 * ─────────────────────────────────────────────────────────────────────────
 * It is the accessibility answer and the bad-bandwidth answer (build plan §8
 * decision 2), so it is offered on every question rather than surfacing only
 * after something breaks. The server records WHICH mode each answer used, so
 * a typed answer can never later be described as something the candidate said
 * aloud.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

interface RecordingConsent {
  decision: "granted" | "declined" | "withdrawn" | null;
  decidedAt: string | null;
  consentVersion: string | null;
  capturedVia: string | null;
  permitted: boolean;
}

interface Disclosure {
  version: string;
  title: string;
  body: string[];
  grantLabel: string;
  declineLabel: string;
  declinedTitle: string;
  declinedBody: string[];
}

/** Exactly what the wire carries for a question: no rubricKey, no lookahead. */
interface CandidateQuestion {
  key: string;
  prompt: string;
  index: number;
  of: number;
}

interface SessionView {
  sessionId: string;
  interviewId: string;
  status: "draft" | "approved" | "issued" | "in_progress" | "submitted" | "expired" | "cancelled";
  candidateName: string;
  companyName: string;
  companyLogoUrl: string | null;
  companyPrimaryColor: string | null;
  positionTitle: string;
  roundName: string;
  questionCount: number;
  answeredCount: number;
  currentQuestion: CandidateQuestion | null;
  disclosure: Disclosure;
  recordingConsent: RecordingConsent;
  startedAt: string | null;
  submittedAt: string | null;
  expiresAt: string | null;
  answerTextMax: number;
  maxUploadBytes: number;
  allowedContentTypes: string[];
  roundAudio: "cumulative";
}

/** The API's refusal envelope: `message` is candidate-facing copy already. */
interface Refusal {
  ok: false;
  reason: string;
  message?: string;
}

type AnswerMode = "voice" | "typed";

export function AiInterviewClient({ token }: { token: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The decline screen is local state, not a status: the server records the
  // decision and refuses the round, but 'issued' is still what the session is.
  const [declined, setDeclined] = useState(false);

  const [mode, setMode] = useState<AnswerMode>("voice");
  const [typed, setTyped] = useState("");
  const [speaking, setSpeaking] = useState(false);

  const recorderRef = useRef<RoundRecorder | null>(null);
  const answerStartRef = useRef<number | null>(null);
  const mimeTypeRef = useRef<string | null>(null);

  // Negotiated once the view lands, because it needs the served
  // allowedContentTypes — and before anyone speaks, so an unrecordable browser
  // shows the typed round from the start rather than after a lost answer.
  const [mimeReady, setMimeReady] = useState(false);
  useEffect(() => {
    if (!view || mimeReady) return;
    const supported =
      typeof MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices;
    mimeTypeRef.current = supported
      ? pickRecorderMimeType(view.allowedContentTypes, (m) => MediaRecorder.isTypeSupported(m))
      : null;
    setMimeReady(true);
  }, [view, mimeReady]);

  const voice = voiceAvailability({
    answeredCount: view?.answeredCount ?? 0,
    recorderStarted: recorderRef.current !== null,
    mimeType: mimeTypeRef.current,
  });
  // A browser or a resumed round that cannot do voice is put into typed mode
  // rather than shown a button that is certain to be refused.
  useEffect(() => {
    if (mimeReady && !voice.available) setMode("typed");
  }, [mimeReady, voice.available]);

  // Release the microphone if the candidate navigates away mid-round. The
  // answers already checkpointed are safe in storage; only the un-uploaded
  // tail is lost, which is what the resume rule then accounts for.
  useEffect(() => () => recorderRef.current?.stop(), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/interviews/ai/${token}`);
      const body = (await res.json()) as (SessionView & { ok: true }) | Refusal;
      if (!body.ok) {
        setLoadError(body.message ?? friendlyReason(body.reason));
        return;
      }
      setView(body);
    } catch {
      setLoadError("We couldn't load your interview. Check your connection and try again.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every write returns the new view, so applying it IS advancing the round. */
  async function post<T extends object>(
    path: string,
    payload: object,
  ): Promise<(SessionView & T) | null> {
    const res = await fetch(`${API_BASE}/api/interviews/ai/${token}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as (SessionView & T & { ok: true }) | Refusal;
    if (!body.ok) {
      setError(body.message ?? friendlyReason(body.reason));
      // A refusal usually means our picture of the round is stale — an expiry
      // that lapsed, an answer that already landed. Re-reading is cheaper than
      // guessing which, and it never shows a state the server does not hold.
      await load();
      return null;
    }
    setError(null);
    setView(body);
    return body;
  }

  async function onConsent(granted: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (!granted) {
        // The decision is still written — a refusal is a fact about what the
        // candidate was asked and what they answered — so the call is made
        // and its refusal is the expected outcome, not an error to report.
        await fetch(`${API_BASE}/api/interviews/ai/${token}/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ consent: false }),
        });
        setDeclined(true);
        return;
      }
      await post("/start", { consent: true });
    } finally {
      setBusy(false);
    }
  }

  /** Mark the start of a spoken answer, starting the round's recorder if needed. */
  async function onStartSpeaking() {
    setError(null);
    try {
      if (!recorderRef.current) {
        const mime = mimeTypeRef.current;
        if (!mime) throw new Error("unsupported");
        recorderRef.current = await startRoundRecorder(mime);
      }
      answerStartRef.current = recorderRef.current.elapsedMs();
      setSpeaking(true);
    } catch {
      // Almost always a denied microphone permission. Typing is a real answer,
      // so the round continues in the other mode rather than stopping.
      setMode("typed");
      setSpeaking(false);
      setNotice(
        "We couldn't use your microphone, so please type this answer instead. " +
          "Typed answers are a normal way to complete this round.",
      );
    }
  }

  async function onFinishSpeaking(question: CandidateQuestion) {
    const recorder = recorderRef.current;
    if (!recorder || !view) return;
    setBusy(true);
    setError(null);
    try {
      const endMs = recorder.elapsedMs();
      const startMs = answerStartRef.current ?? 0;
      const blob = await recorder.checkpoint();

      if (blob.size > view.maxUploadBytes) {
        setError(
          "This round's recording has got too large to upload. Please type your remaining " +
            "answers so the ones you have already given are kept.",
        );
        setMode("typed");
        return;
      }

      // The whole round so far, to the round's single key. The server stats
      // the object and refuses it if it shrank — see round-recorder's header.
      const authorised = await post<{
        uploadUrl: string;
        method: "PUT";
        contentType: string;
        provider: "supabase" | "local";
      }>("/answer/upload-url", {
        questionKey: question.key,
        contentType: baseContentType(recorder.mimeType),
        sizeBytes: blob.size,
      });
      if (!authorised) return;

      if (authorised.provider === "local") {
        // The local storage tier mints an un-dereferenceable `local://` url on
        // purpose, so say so rather than throwing a confusing network error.
        setError(
          "This environment has no upload endpoint configured, so please type your answers.",
        );
        setMode("typed");
        return;
      }

      const put = await fetch(authorised.uploadUrl, {
        method: authorised.method,
        headers: { "content-type": authorised.contentType, "x-upsert": "true" },
        body: blob,
      });
      if (!put.ok) {
        setError("That answer didn't upload. Check your connection and press Done again.");
        return;
      }

      const saved = await post("/answer", {
        questionKey: question.key,
        mode: "voice",
        startMs,
        endMs,
      });
      if (saved) {
        setSpeaking(false);
        answerStartRef.current = null;
      }
    } catch {
      setError("Something went wrong saving that answer. Press Done to try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitTyped(question: CandidateQuestion) {
    const text = typed.trim();
    if (text.length === 0) return;
    setBusy(true);
    try {
      const saved = await post("/answer", { questionKey: question.key, mode: "typed", text });
      if (saved) setTyped("");
    } finally {
      setBusy(false);
    }
  }

  async function onFinishRound() {
    setBusy(true);
    try {
      const recorder = recorderRef.current;
      const durationSeconds = recorder ? Math.round(recorder.elapsedMs() / 1000) : undefined;
      const done = await post("/submit", durationSeconds ? { durationSeconds } : {});
      if (done) recorderRef.current?.stop();
    } finally {
      setBusy(false);
    }
  }

  /* ───────────────────────────────── screens ──────────────────────────── */

  if (loadError) {
    return (
      <CandidateShell brand="HireOps" width="2xl">
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <StatusIcon tone="warning" />
          <h1 className="text-lg font-semibold text-neutral-900">This interview link</h1>
          <p className="max-w-md text-sm text-neutral-600">{loadError}</p>
          <p className="max-w-md text-sm text-neutral-600">
            If you think it should still be open, reply to the email that sent you here and your
            recruiter can issue a new link.
          </p>
        </Card>
      </CandidateShell>
    );
  }

  if (!view) {
    return (
      <CandidateShell brand="HireOps" width="5xl">
        <Card className="py-10 text-center text-sm text-neutral-600">Loading your interview…</Card>
      </CandidateShell>
    );
  }

  const d = view.disclosure;
  const shell = {
    brand: view.companyName,
    logoUrl: view.companyLogoUrl,
    accentColor: view.companyPrimaryColor,
    width: "5xl" as const,
  };

  if (declined) {
    return (
      <CandidateShell {...shell}>
        <RoundLayout view={view} phase="consent">
          <Card className="flex flex-col gap-4 p-6 sm:p-8">
            <h1 className="text-xl font-semibold text-neutral-900">{d.declinedTitle}</h1>
            {d.declinedBody.map((p) => (
              <p key={p} className="text-[15px] leading-7 text-neutral-700">
                {p}
              </p>
            ))}
          </Card>
        </RoundLayout>
      </CandidateShell>
    );
  }

  if (view.status === "submitted") {
    return (
      <CandidateShell {...shell}>
        <RoundLayout view={view} phase="done">
          <Card className="flex flex-col items-center gap-4 px-6 py-12 text-center sm:px-10">
            <StatusIcon tone="success" />
            <Badge tone="success">Round complete</Badge>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              Thank you — your answers are with {view.companyName}
            </h1>
            <p className="max-w-xl text-[15px] leading-7 text-neutral-600">
              You answered {view.answeredCount} of {view.questionCount} questions for the{" "}
              {view.positionTitle} role. A person from the hiring team reviews what you said and
              will be in touch about next steps. Nothing about this round is decided automatically.
            </p>
          </Card>
        </RoundLayout>
      </CandidateShell>
    );
  }

  if (view.status === "expired" || view.status === "cancelled") {
    return (
      <CandidateShell {...shell}>
        <RoundLayout view={view} phase="closed">
          <Card className="flex flex-col items-center gap-4 px-6 py-12 text-center">
            <StatusIcon tone="warning" />
            <Badge tone="warning">{view.status === "expired" ? "Link expired" : "Withdrawn"}</Badge>
            <h1 className="text-xl font-semibold text-neutral-900">This round is closed</h1>
            <p className="max-w-md text-sm text-neutral-600">
              {view.status === "expired"
                ? "The time to complete this interview has passed."
                : "This interview round was withdrawn."}{" "}
              Your recruiter can tell you what happens next.
            </p>
          </Card>
        </RoundLayout>
      </CandidateShell>
    );
  }

  // 'issued' — the disclosure and the consent decision, before anything else.
  if (view.status === "issued") {
    return (
      <CandidateShell {...shell}>
        <RoundLayout view={view} phase="consent">
          <RoundHero view={view} />

          <Card className="flex flex-col gap-5 p-6 sm:p-8">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                <IconShield />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">{d.title}</h2>
                <p className="mt-0.5 text-sm text-neutral-500">
                  Please read this before you begin — it explains how the round works.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-4 border-t border-neutral-100 pt-5">
              {d.body.map((p) => (
                <p key={p} className="text-[15px] leading-7 text-neutral-700">
                  {p}
                </p>
              ))}
            </div>
            {error ? <ErrorNote message={error} /> : null}
            <div className="grid gap-3 border-t border-neutral-100 pt-5 sm:grid-cols-2">
              <Button
                size="lg"
                disabled={busy}
                onClick={() => void onConsent(true)}
                className={WRAP_BUTTON}
              >
                {d.grantLabel}
              </Button>
              <Button
                size="lg"
                variant="secondary"
                disabled={busy}
                onClick={() => void onConsent(false)}
                className={WRAP_BUTTON}
              >
                {d.declineLabel}
              </Button>
            </div>
            <p className="text-xs text-neutral-400">Disclosure version {d.version}</p>
          </Card>
        </RoundLayout>
      </CandidateShell>
    );
  }

  // 'in_progress' with no current question — every question is answered and
  // only the submit is left. Deliberately a separate step: submitting is what
  // sends the round, and it should be a decision rather than a side effect of
  // answering the last question.
  const q = view.currentQuestion;
  if (!q) {
    return (
      <CandidateShell {...shell}>
        <RoundLayout view={view} phase="submit">
          <Card className="flex flex-col gap-4 p-6 sm:p-8">
            <Badge tone="success">All {view.questionCount} questions answered</Badge>
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              Ready to send
            </h1>
            <p className="text-[15px] leading-7 text-neutral-600">
              Nothing is sent to {view.companyName} until you finish. Once you do, your answers go
              to the hiring team and this round is closed.
            </p>
            {error ? <ErrorNote message={error} /> : null}
            <div>
              <Button size="lg" disabled={busy} onClick={() => void onFinishRound()}>
                {busy ? "Sending…" : "Finish and send my answers"}
              </Button>
            </div>
          </Card>
        </RoundLayout>
      </CandidateShell>
    );
  }

  return (
    <CandidateShell {...shell}>
      <RoundLayout view={view} phase="questions">
        <Card className="flex flex-col gap-4 p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Question {q.index} of {q.of}
            </span>
            {speaking ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-status-error-50 px-2.5 py-1 text-xs font-medium text-status-error-700">
                <span className="h-2 w-2 animate-pulse rounded-full bg-status-error-500" />
                Recording
              </span>
            ) : null}
          </div>
          <ProgressBar value={view.answeredCount} max={view.questionCount} />
          <p className="text-lg leading-8 text-neutral-900">{q.prompt}</p>
        </Card>

        {notice ? (
          <Card className="border-status-warning-200 bg-status-warning-50 text-sm text-status-warning-800">
            {notice}
          </Card>
        ) : null}
        {voice.reason ? (
          <Card className="border-neutral-200 bg-neutral-50 text-sm text-neutral-700">
            {voice.reason}
          </Card>
        ) : null}

        <Card className="flex flex-col gap-4 p-6 sm:p-8">
          {mode === "voice" && voice.available ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <span
                  className={
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full " +
                    (speaking
                      ? "bg-status-error-50 text-status-error-600"
                      : "bg-brand-50 text-brand-700")
                  }
                >
                  <IconMic />
                </span>
                <p className="text-sm leading-6 text-neutral-600">
                  Answer out loud in your own time, then press Done. Your microphone stays on for
                  the whole round.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                {!speaking ? (
                  <Button size="lg" disabled={busy} onClick={() => void onStartSpeaking()}>
                    Start answering
                  </Button>
                ) : (
                  <Button size="lg" disabled={busy} onClick={() => void onFinishSpeaking(q)}>
                    {busy ? "Saving your answer…" : "Done with this answer"}
                  </Button>
                )}
                {!speaking ? (
                  <button
                    type="button"
                    className="text-sm font-medium text-brand-700 hover:underline"
                    onClick={() => setMode("typed")}
                  >
                    I'd rather type this answer
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label htmlFor="typed-answer" className="text-sm font-medium text-neutral-700">
                Type your answer
              </label>
              <textarea
                id="typed-answer"
                value={typed}
                maxLength={view.answerTextMax}
                onChange={(e) => setTyped(e.target.value)}
                rows={10}
                className="w-full rounded-md border border-neutral-300 p-3 text-[15px] leading-7 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-500">
                  {typed.length} / {view.answerTextMax}
                </span>
                {voice.available ? (
                  <button
                    type="button"
                    className="text-sm font-medium text-brand-700 hover:underline"
                    onClick={() => setMode("voice")}
                  >
                    Answer out loud instead
                  </button>
                ) : null}
              </div>
              <div>
                <Button
                  size="lg"
                  disabled={busy || typed.trim().length === 0}
                  onClick={() => void onSubmitTyped(q)}
                >
                  {busy ? "Saving…" : "Save and continue"}
                </Button>
              </div>
            </div>
          )}
          {error ? <ErrorNote message={error} /> : null}
        </Card>
      </RoundLayout>
    </CandidateShell>
  );
}

/* ─────────────────────────────── layout pieces ─────────────────────────── */

/** Server-served labels can be long; let the button grow instead of clipping. */
const WRAP_BUTTON = "h-auto min-h-12 whitespace-normal py-3 text-center leading-snug";

type Phase = "consent" | "questions" | "submit" | "done" | "closed";

/** Main column + a round-summary sidebar (stacks below on small screens). */
function RoundLayout({
  view,
  phase,
  children,
}: {
  view: SessionView;
  phase: Phase;
  children: ReactNode;
}) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      <RoundSidebar view={view} phase={phase} />
    </div>
  );
}

function RoundHero({ view }: { view: SessionView }) {
  return (
    <Card className="flex flex-col gap-3 p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">AI first round</Badge>
        <span className="text-xs font-medium text-neutral-500">{view.roundName}</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
        {view.positionTitle}
      </h1>
      <p className="text-[15px] leading-7 text-neutral-600">
        Hello {view.candidateName}. This round has {view.questionCount} questions and you can take
        it whenever suits you
        {view.expiresAt ? ` before ${formatDate(view.expiresAt)}` : ""}.
      </p>
    </Card>
  );
}

function RoundSidebar({ view, phase }: { view: SessionView; phase: Phase }) {
  const steps: { key: string; label: string; state: "done" | "current" | "todo" }[] = [
    {
      key: "consent",
      label: "Read how this round works",
      state: phase === "consent" ? "current" : "done",
    },
    {
      key: "questions",
      label: `Answer ${view.questionCount} questions`,
      state: phase === "consent" ? "todo" : phase === "questions" ? "current" : "done",
    },
    {
      key: "submit",
      label: "Send your answers",
      state: phase === "submit" ? "current" : phase === "done" ? "done" : "todo",
    },
  ];
  return (
    <aside className="flex flex-col gap-5 lg:sticky lg:top-6">
      <Card className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Your interview
          </p>
          <p className="mt-1 font-semibold text-neutral-900">{view.positionTitle}</p>
          <p className="text-sm text-neutral-500">{view.companyName}</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 border-t border-neutral-100 pt-4 text-sm">
          <div>
            <dt className="text-xs text-neutral-500">Questions</dt>
            <dd className="font-medium text-neutral-900">
              {phase === "questions" || phase === "submit"
                ? `${view.answeredCount} of ${view.questionCount} done`
                : view.questionCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Complete by</dt>
            <dd className="font-medium text-neutral-900">
              {view.expiresAt ? formatShortDate(view.expiresAt) : "—"}
            </dd>
          </div>
        </dl>
        {phase !== "closed" ? (
          <ol className="flex flex-col gap-3 border-t border-neutral-100 pt-4">
            {steps.map((s, i) => (
              <li key={s.key} className="flex items-center gap-3 text-sm">
                <span
                  className={
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold " +
                    (s.state === "done"
                      ? "bg-status-positive-500 text-white"
                      : s.state === "current"
                        ? "bg-brand-600 text-white"
                        : "border border-neutral-300 text-neutral-400")
                  }
                >
                  {s.state === "done" ? "✓" : i + 1}
                </span>
                <span
                  className={
                    s.state === "current"
                      ? "font-medium text-neutral-900"
                      : s.state === "done"
                        ? "text-neutral-600"
                        : "text-neutral-400"
                  }
                >
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </Card>

      {phase === "consent" || phase === "questions" ? (
        <Card className="flex flex-col gap-3 bg-neutral-50/80">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Before you start
          </p>
          <ul className="flex flex-col gap-2.5 text-sm leading-6 text-neutral-600">
            <li>Find a quiet place and allow microphone access when your browser asks.</li>
            <li>You see one question at a time and can take as long as you need.</li>
            <li>Prefer to type? Every question can be answered in writing instead.</li>
          </ul>
        </Card>
      ) : null}
    </aside>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        className="h-full rounded-full bg-brand-600 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800">
      {message}
    </p>
  );
}

function StatusIcon({ tone }: { tone: "success" | "warning" }) {
  const cls =
    tone === "success"
      ? "bg-status-positive-50 text-status-positive-600"
      : "bg-status-warning-50 text-status-warning-600";
  return (
    <span className={`flex h-12 w-12 items-center justify-center rounded-full ${cls}`}>
      {tone === "success" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-6 w-6"
          aria-hidden
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-6 w-6"
          aria-hidden
        >
          <path d="M12 8v5M12 16.5v.5" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      )}
    </span>
  );
}

function IconShield() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-5 w-5"
      aria-hidden
    >
      <path
        d="M12 3l7 3v5.5c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V6l7-3z"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-5 w-5"
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" strokeLinecap="round" />
    </svg>
  );
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Fallbacks only — the API sends candidate-facing copy with every refusal. */
function friendlyReason(reason: string | undefined): string {
  switch (reason) {
    case "expired":
      return "The time to complete this interview has passed.";
    case "cancelled":
      return "This interview round was withdrawn.";
    case "already_submitted":
      return "You have already completed this round.";
    case "not_found":
    case "invalid_signature":
    case "wrong_action":
      return "This link isn't valid.";
    default:
      return "We couldn't open this interview.";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
