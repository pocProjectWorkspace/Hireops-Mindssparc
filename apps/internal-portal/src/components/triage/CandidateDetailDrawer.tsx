"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, Badge, Button } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { useUndoToast } from "./UndoToastProvider";
import { OfferSection } from "@/components/offers/OfferSection";
import { InterviewScheduleSection } from "@/components/interviews/InterviewScheduleSection";

/**
 * Slide-in drawer at 60vw with backdrop, Esc-to-close, click-backdrop-
 * to-close. Browser back works automatically because the URL search
 * param drives mount/unmount — Next's routing handles popstate.
 *
 * Fetches by candidateId via getCandidateById; does NOT read from the
 * parent list state. That's deliberate — deep-linking a /triage?candidateId=xyz
 * URL must work even if xyz isn't in the current filter view.
 *
 * Mutations operate on applicationId (also carried in the URL — see
 * use-drawer-routing.ts for why we extended the ticket's URL pattern
 * to include both).
 *
 * DESIGN-02: the drawer is a structured candidate profile — identity header
 * with avatar + contact, a Skills chip section and an Experience summary drawn
 * from the already-fetched parsed_skills, the Offer section, and a collapsible
 * raw-parse fallback. The AI score itself isn't in getCandidateById's payload
 * (it lives on the triage row), so it's surfaced there, not re-fetched here.
 */

// Module 1b fixes the forward step at recruiter_review (the first stage
// past application_received). Module 1c will let the recruiter choose
// any legal next stage.
const ADVANCE_TARGET_STAGE = "recruiter_review";

/** parsed_skills is jsonb (typed unknown); narrow the fields we render. */
interface WorkItem {
  company?: string;
  title?: string;
  start_date?: string | null;
  end_date?: string | null;
  highlights?: string[];
}
interface ParsedSkills {
  skills?: string[];
  work_history?: WorkItem[];
  notice_period_days?: number;
}
function narrowParsed(value: unknown): ParsedSkills {
  if (!value || typeof value !== "object") return {};
  return value as ParsedSkills;
}
function dateRange(start?: string | null, end?: string | null): string {
  if (!start) return "";
  return `${start} – ${end ?? "Present"}`;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </h3>
  );
}

export function CandidateDetailDrawer() {
  const { candidateId, applicationId, close } = useDrawerRouting();
  const queryClient = useQueryClient();
  const { show: showToast, onUndo, dismiss: dismissToast } = useUndoToast();

  // Esc-to-close + body scroll lock while open.
  useEffect(() => {
    if (!candidateId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [candidateId, close]);

  const detail = trpc.getCandidateById.useQuery(
    { id: candidateId ?? "" },
    { enabled: !!candidateId },
  );

  const revert = trpc.revertApplicationStage.useMutation({
    onSuccess: () => {
      // Re-enable the row in the list: cheapest correct option is
      // refetch all listCandidates queries. Avoids guessing which
      // cache entries held the removed row (HotZone + MomentumFeed
      // both query listCandidates with different inputs).
      queryClient.invalidateQueries({ queryKey: [["listCandidates"]] });
    },
  });

  const advance = trpc.advanceApplication.useMutation({
    onSuccess: (out) => {
      showToast({
        message: `Moved to ${out.toStage.replace(/_/g, " ")}`,
        applicationId: out.applicationId,
        transitionId: out.transitionId,
        candidateName: detail.data?.person?.fullName ?? "candidate",
      });
      queryClient.invalidateQueries({ queryKey: [["listCandidates"]] });
      close();
    },
  });

  const reject = trpc.rejectApplication.useMutation({
    onSuccess: (out) => {
      showToast({
        message: "Candidate rejected",
        applicationId: out.applicationId,
        transitionId: out.transitionId,
        candidateName: detail.data?.person?.fullName ?? "candidate",
      });
      queryClient.invalidateQueries({ queryKey: [["listCandidates"]] });
      close();
    },
  });

  // Register the undo handler. The provider stores handlers in a Set;
  // re-registering across renders is harmless because the cleanup
  // returned by onUndo unsubscribes the prior instance.
  useEffect(() => {
    return onUndo(async (state) => {
      try {
        await revert.mutateAsync({
          applicationId: state.applicationId,
          transitionId: state.transitionId,
        });
        dismissToast();
      } catch (err) {
        console.error("[Drawer] undo failed", err);
      }
    });
  }, [onUndo, revert, dismissToast]);

  if (!candidateId) return null;

  const isPending = advance.isPending || reject.isPending;
  const person = detail.data?.person;
  const candidate = detail.data?.candidate;
  const parsed = narrowParsed(candidate?.parsedSkills);
  const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
  const work = Array.isArray(parsed.work_history) ? parsed.work_history : [];
  const name = person?.fullName ?? "(no name)";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Candidate detail"
      className="fixed inset-0 z-modal flex justify-end"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={close}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[60vw] max-w-3xl flex-col overflow-hidden bg-neutral-50 shadow-3">
        {/* Identity header */}
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-6 py-5">
          {detail.isLoading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : detail.error ? (
            <p className="text-sm text-status-error-700">Couldn&apos;t load candidate detail.</p>
          ) : (
            <div className="flex min-w-0 items-center gap-3.5">
              <Avatar name={name} seed={candidateId} size="lg" />
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold tracking-tight text-neutral-900">
                  {name}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm text-neutral-500">{person?.email ?? "—"}</span>
                  {candidate?.source ? (
                    <Badge tone="neutral">{candidate.source.replace(/_/g, " ")}</Badge>
                  ) : null}
                  {typeof parsed.notice_period_days === "number" ? (
                    <Badge tone="info">{parsed.notice_period_days}d notice</Badge>
                  ) : null}
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={close}
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Skills */}
          {skills.length > 0 ? (
            <section className="rounded-lg border border-neutral-200 bg-white p-4">
              <SectionHeading>Parsed skills</SectionHeading>
              <ul className="flex flex-wrap gap-1.5">
                {skills.map((s, i) => (
                  <li key={i}>
                    <Badge tone="accent" pill>
                      {s}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Experience */}
          {work.length > 0 ? (
            <section className="rounded-lg border border-neutral-200 bg-white p-4">
              <SectionHeading>Experience</SectionHeading>
              <ol className="space-y-3">
                {work.map((w, i) => (
                  <li key={i} className="border-l-2 border-neutral-200 pl-3">
                    <p className="text-sm font-medium text-neutral-900">
                      {w.title ?? "—"}
                      {w.company ? <span className="text-neutral-500"> · {w.company}</span> : null}
                    </p>
                    {dateRange(w.start_date, w.end_date) ? (
                      <p className="text-xs tabular-nums text-neutral-400">
                        {dateRange(w.start_date, w.end_date)}
                      </p>
                    ) : null}
                    {Array.isArray(w.highlights) && w.highlights.length > 0 ? (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-neutral-600">
                        {w.highlights.map((h, j) => (
                          <li key={j}>{h}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {applicationId ? <InterviewScheduleSection applicationId={applicationId} /> : null}

          {applicationId ? <OfferSection applicationId={applicationId} /> : null}

          {/* Raw parse — collapsible fallback for the full jsonb payload. */}
          {candidate?.parsedSkills ? (
            <details className="group rounded-lg border border-neutral-200 bg-white p-4">
              <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-neutral-500 transition-colors hover:text-neutral-700">
                Parsed résumé (raw)
              </summary>
              <pre className="mt-3 overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-xs text-neutral-700">
                {JSON.stringify(candidate.parsedSkills, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>

        <footer className="flex gap-2 border-t border-neutral-200 bg-white px-6 py-4">
          <Button
            variant="primary"
            disabled={isPending || !applicationId}
            onClick={() => {
              if (!applicationId) return;
              advance.mutate({ applicationId, targetStage: ADVANCE_TARGET_STAGE });
            }}
          >
            {advance.isPending ? "Advancing…" : "Advance"}
          </Button>
          <Button
            variant="danger"
            disabled={isPending || !applicationId}
            onClick={() => {
              if (!applicationId) return;
              reject.mutate({ applicationId });
            }}
          >
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Button>
        </footer>
      </aside>
    </div>
  );
}
