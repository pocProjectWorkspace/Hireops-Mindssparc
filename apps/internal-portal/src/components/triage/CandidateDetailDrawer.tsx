"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";
import { useDrawerRouting } from "@/lib/use-drawer-routing";
import { useUndoToast } from "./UndoToastProvider";
import { AIScoreBadge } from "./AIScoreBadge";
import { OfferSection } from "@/components/offers/OfferSection";

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
 * Advance/Reject mutations:
 *   - onSuccess: show UndoToast with the returned transitionId, then
 *     invalidate listCandidates so the optimistic-removed row stays
 *     gone (or comes back via the revert + invalidate cycle).
 * UndoToast registers an onUndo handler that calls
 * revertApplicationStage; on undo success we invalidate the list so
 * the row reappears.
 */

// Module 1b fixes the forward step at recruiter_review (the first stage
// past application_received). Module 1c will let the recruiter choose
// any legal next stage.
const ADVANCE_TARGET_STAGE = "recruiter_review";

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
        className="absolute inset-0 bg-neutral-900/40"
      />
      <aside className="relative ml-auto flex h-full w-[60vw] flex-col overflow-y-auto bg-white shadow-3">
        <header className="flex items-start justify-between border-b border-neutral-200 px-6 py-4">
          <div>
            {detail.isLoading ? (
              <p className="text-sm text-neutral-500">Loading…</p>
            ) : detail.error ? (
              <p className="text-sm text-status-error-700">Couldn&apos;t load candidate detail.</p>
            ) : (
              <>
                <h2 className="text-xl font-semibold text-neutral-900">
                  {detail.data?.person?.fullName ?? "(no name)"}
                </h2>
                <p className="text-sm text-neutral-600">
                  {detail.data?.person?.email ?? "—"} ·{" "}
                  {detail.data?.candidate?.source ?? "unknown source"}
                </p>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-6 px-6 py-4">
          {detail.data && (
            // AI score lives on the application row but getCandidateById
            // (API-01 surface) returns only candidate-level data —
            // parsedSkills jsonb is the only signal we have here today.
            // Once a Module 1c "getApplicationDetail" ships, swap to
            // that for the full score + explanation breakdown.
            <AIScoreBadge
              score={null}
              explanation={detail.data.candidate?.parsedSkills}
              variant="drawer"
            />
          )}

          {applicationId ? <OfferSection applicationId={applicationId} /> : null}

          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h3 className="mb-2 text-base font-semibold text-neutral-900">Parser preview</h3>
            <pre className="overflow-x-auto rounded bg-neutral-100 p-2 font-mono text-xs text-neutral-800">
              {JSON.stringify(detail.data?.candidate?.parsedSkills ?? {}, null, 2)}
            </pre>
          </section>
        </div>

        <footer className="sticky bottom-0 flex gap-2 border-t border-neutral-200 bg-white px-6 py-4">
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
            variant="secondary"
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
