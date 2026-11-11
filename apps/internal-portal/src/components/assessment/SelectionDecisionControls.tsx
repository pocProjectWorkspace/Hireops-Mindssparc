"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { useApplicationStageLabel } from "@/components/TenantLabelsProvider";
import {
  SELECTION_DECISION_LABELS,
  SELECTION_DECISION_OPEN_STAGES,
  type ApplicationStage,
  type SelectionDecision,
  type SelectionDecisionReason,
} from "@hireops/api-types";
import { SelectionDecisionChip } from "./SelectionDecisionChip";

/**
 * PC-12 — the explicit, human final decision: Selected / Not selected / On
 * hold, with a reason from the tenant's list and optional notes. The server
 * re-checks who may decide (HM of this requisition, recruiter, admin) and runs
 * every existing stage gate; this form only collects the choice.
 */

const BUTTONS: {
  decision: SelectionDecision;
  label: string;
  variant: "primary" | "secondary" | "danger";
}[] = [
  { decision: "selected", label: "Select", variant: "primary" },
  { decision: "on_hold", label: "Put on hold", variant: "secondary" },
  { decision: "not_selected", label: "Not selected", variant: "danger" },
];

const EFFECT: Record<SelectionDecision, string> = {
  selected:
    "Moves the application to the offer stage, ready for the offer handoff. The candidate gets the usual stage update; the offer itself is still drafted by the recruiter.",
  not_selected:
    "Closes the application through the normal reject path. The candidate gets the usual closing email.",
  on_hold: "Records the decision only — the stage does not change.",
};

export function SelectionDecisionControls({
  applicationId,
  currentStage,
  reasons,
}: {
  applicationId: string;
  currentStage: ApplicationStage;
  reasons: SelectionDecisionReason[];
}) {
  const queryClient = useQueryClient();
  // CFG-LITE — tenant stage wording.
  const applicationStageLabel = useApplicationStageLabel();
  const [pending, setPending] = useState<SelectionDecision | null>(null);
  const [reasonKey, setReasonKey] = useState("");
  const [notes, setNotes] = useState("");

  const history = trpc.listSelectionDecisions.useQuery({ applicationId }, { retry: false });
  const record = trpc.recordSelectionDecision.useMutation({
    onSuccess: () => {
      setPending(null);
      setReasonKey("");
      setNotes("");
      for (const key of [
        "listSelectionDecisions",
        "listLatestSelectionDecisions",
        "getCandidateAssessmentSummary",
        "getCandidateById",
        "listCandidates",
        "listCandidatesByRequisition",
        "listInterviewsByApplication",
        "listOffersByApplication",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [[key]] });
      }
    },
  });

  const open = SELECTION_DECISION_OPEN_STAGES.has(currentStage);
  const applicable = pending ? reasons.filter((r) => r.appliesTo.includes(pending)) : [];
  const latest = history.data?.latest ?? null;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Selection decision
        </h4>
        {latest ? (
          <SelectionDecisionChip decision={latest.decision} reasonLabel={latest.reasonLabel} />
        ) : null}
      </div>

      {!open ? (
        <p className="text-xs text-neutral-500">
          A decision can be recorded while the candidate is interviewing (tech interview, HR round
          or offer stage). This application is at {applicationStageLabel(currentStage)}.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {BUTTONS.map((b) => (
              <Button
                key={b.decision}
                size="sm"
                variant={pending === b.decision ? b.variant : "secondary"}
                disabled={record.isPending}
                onClick={() => {
                  setPending(b.decision);
                  setReasonKey("");
                }}
              >
                {b.label}
              </Button>
            ))}
          </div>

          {pending ? (
            <div className="mt-3 space-y-2 rounded-md border border-neutral-100 bg-neutral-50 p-3">
              <p className="text-xs text-neutral-600">
                <span className="font-semibold text-neutral-800">
                  {SELECTION_DECISION_LABELS[pending]}.
                </span>{" "}
                {EFFECT[pending]}
              </p>
              <label className="block text-xs text-neutral-600">
                Reason
                <select
                  value={reasonKey}
                  onChange={(e) => setReasonKey(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                >
                  <option value="">No reason given</option>
                  {applicable.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-neutral-600">
                Notes (internal)
                <textarea
                  value={notes}
                  maxLength={2000}
                  rows={2}
                  onChange={(e) => setNotes(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={pending === "not_selected" ? "danger" : "primary"}
                  disabled={record.isPending}
                  onClick={() =>
                    record.mutate({
                      applicationId,
                      decision: pending,
                      ...(reasonKey ? { reasonKey } : {}),
                      ...(notes.trim() ? { notes: notes.trim() } : {}),
                    })
                  }
                >
                  {record.isPending ? "Recording…" : "Confirm decision"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={record.isPending}
                  onClick={() => setPending(null)}
                >
                  Cancel
                </Button>
              </div>
              {record.error ? (
                <p className="text-xs text-status-error-700">{record.error.message}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {history.data && history.data.history.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-neutral-500 hover:text-neutral-700">
            Decision history ({history.data.history.length})
          </summary>
          <ol className="mt-2 space-y-1.5">
            {history.data.history.map((h) => (
              <li key={h.id} className="text-xs text-neutral-600">
                <SelectionDecisionChip decision={h.decision} compact />{" "}
                {h.reasonLabel ? <span className="text-neutral-800">{h.reasonLabel}</span> : null}
                <span className="text-neutral-400">
                  {" "}
                  · {h.decidedByName ?? "Someone"} ·{" "}
                  {new Date(h.decidedAt).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {h.notes ? <p className="mt-0.5 pl-1 text-neutral-500">{h.notes}</p> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
