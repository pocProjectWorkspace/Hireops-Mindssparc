"use client";

import { useState } from "react";
import {
  BULK_MOVE_MAX,
  type ApplicationStage,
  type BulkMoveApplicationsInput,
  type BulkMoveApplicationsOutput,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui";
import { useApplicationStageLabel } from "@/components/TenantLabelsProvider";

/**
 * PC-5 — the checkbox bulk-action bar on the candidates-by-role list. Shown
 * while a selection exists. Three actions, all ONE server mutation
 * (bulkMoveApplications) with per-row results:
 *   - Advance to next stage (each row's own next stage)
 *   - Move to stage X
 *   - Reject… (opens a confirm dialog with a preview of the closing email)
 *
 * The reject path always sends candidate.application_closed to candidates with
 * an email on file and has no suppression switch, so the dialog shows the
 * preview and says so — it does not offer a "don't send" toggle.
 */

export type BulkSelection = BulkMoveApplicationsInput["selection"];

const MOVE_TARGETS: ApplicationStage[] = [
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "withdrawn",
];

export function BulkActionsBar({
  selection,
  count,
  previewRequisitionId,
  onDone,
  onClear,
}: {
  selection: BulkSelection;
  /** How many applications the selection covers (page ids, or all matching). */
  count: number;
  /** Role whose title the reject preview uses, when the selection is one role. */
  previewRequisitionId: string | null;
  onDone: (result: BulkMoveApplicationsOutput) => void;
  onClear: () => void;
}) {
  const utils = trpc.useUtils();
  // CFG-LITE — tenant stage wording in the move-to-stage picker.
  const stageLabel = useApplicationStageLabel();
  const [moveTarget, setMoveTarget] = useState<ApplicationStage>("shortlisted");
  const [rejectOpen, setRejectOpen] = useState(false);

  const bulk = trpc.bulkMoveApplications.useMutation({
    onSuccess: (res) => {
      void utils.listCandidatesByRequisition.invalidate();
      void utils.listShortlist.invalidate();
      void utils.listCandidates.invalidate();
      setRejectOpen(false);
      onDone(res);
    },
  });

  const overCap = count > BULK_MOVE_MAX;
  const disabled = bulk.isPending || count === 0 || overCap;
  const run = (input: Omit<BulkMoveApplicationsInput, "selection">) =>
    bulk.mutate({ ...input, selection });

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-brand-200 bg-brand-50 px-4 py-2.5"
    >
      <span className="text-sm font-medium text-brand-900 tabular-nums">
        {count.toLocaleString("en-IN")} selected
      </span>
      {overCap ? (
        <span className="text-xs text-status-error-700">
          Bulk actions are limited to {BULK_MOVE_MAX} at a time. Narrow the filters.
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => run({ action: "advance_next" })}
        >
          Advance to next stage
        </Button>
        <label className="flex items-center gap-1">
          <span className="sr-only">Target stage</span>
          <select
            aria-label="Target stage"
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value as ApplicationStage)}
            className="h-8 rounded-button border border-neutral-300 bg-white px-2 text-sm text-neutral-700"
          >
            {MOVE_TARGETS.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => run({ action: "move_to_stage", targetStage: moveTarget })}
        >
          Move
        </Button>
        <Button size="sm" variant="danger" disabled={disabled} onClick={() => setRejectOpen(true)}>
          Reject…
        </Button>
        <Button size="sm" variant="ghost" disabled={bulk.isPending} onClick={onClear}>
          Clear selection
        </Button>
      </div>
      {bulk.isPending ? (
        <p className="w-full text-xs text-brand-800" role="status">
          Working… each candidate goes through the same checks as a single move.
        </p>
      ) : null}
      {bulk.error ? (
        <p className="w-full text-xs text-status-error-700" role="alert">
          {bulk.error.message}
        </p>
      ) : null}
      {rejectOpen ? (
        <RejectDialog
          count={count}
          requisitionId={previewRequisitionId}
          pending={bulk.isPending}
          onCancel={() => setRejectOpen(false)}
          onConfirm={(reason) => run({ action: "reject", ...(reason ? { reason } : {}) })}
        />
      ) : null}
    </div>
  );
}

function RejectDialog({
  count,
  requisitionId,
  pending,
  onCancel,
  onConfirm,
}: {
  count: number;
  requisitionId: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  const preview = trpc.previewApplicationClosedEmail.useQuery(
    requisitionId ? { requisitionId } : {},
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Reject candidates"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-neutral-200 bg-white shadow-card">
        <div className="border-b border-neutral-100 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-900">
            Reject {count.toLocaleString("en-IN")} candidate{count === 1 ? "" : "s"}?
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            Every candidate with an email on file is sent the closing email below (their own name
            and role are filled in). Candidates who are already closed are skipped.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <label className="mb-4 block text-sm">
            <span className="mb-1 block font-medium text-neutral-800">
              Internal reason (optional, not sent to the candidate)
            </span>
            <input
              type="text"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Notice period over 60 days"
              className="h-9 w-full rounded-button border border-neutral-300 px-3 text-sm focus:border-brand-500 focus:outline-none"
            />
          </label>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Email preview
          </p>
          {preview.isLoading ? (
            <p className="text-sm text-neutral-500">Loading preview…</p>
          ) : preview.error ? (
            <p className="text-sm text-status-error-700">
              Couldn&apos;t load the preview: {preview.error.message}
            </p>
          ) : preview.data ? (
            <div className="overflow-hidden rounded-card border border-neutral-200">
              <p className="border-b border-neutral-100 bg-neutral-50 px-3 py-2 text-sm">
                <span className="text-neutral-500">Subject: </span>
                <span className="font-medium text-neutral-900">{preview.data.subject}</span>
              </p>
              <iframe
                title="Closing email preview"
                srcDoc={preview.data.html}
                sandbox=""
                className="h-80 w-full bg-white"
              />
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-6 py-3">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => onConfirm(reason.trim() ? reason.trim() : null)}
          >
            {pending ? "Rejecting…" : "Reject and send email"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Human text for a per-row skip reason. */
export function skipReasonLabel(reason: string | null): string {
  switch (reason) {
    case "closed":
      return "Already closed";
    case "no_next_stage":
      return "No next stage";
    case "already_at_stage":
      return "Already at that stage";
    case "gate_blocked":
      return "Blocked by a stage check";
    case "not_found":
      return "Not found";
    default:
      return "Could not be moved";
  }
}
