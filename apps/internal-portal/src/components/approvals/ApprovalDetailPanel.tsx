"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";
import { asDraftPayload, formatCostMicros, timeAgo } from "@/lib/approval-format";

/**
 * The right-hand detail + decision surface of the approval queue, and the
 * demo's hero interaction: a recruiter reads the agent's drafted message,
 * optionally edits it, and approves — at which point send_message runs
 * for the first time and the email goes out (FOLLOWUP-01 gates the draft,
 * not the send).
 *
 * For draft_message payloads (follow-ups, Q&A) the subject + body are
 * shown in editable fields; editing then approving routes through
 * approveApprovalWithEdit so the recruiter's text is what ships. For any
 * other action type the raw payload is shown read-only as JSON until that
 * agent gets its own review UI — approve/reject/snooze still work.
 *
 * All four resolutions invalidate the queue list so the resolved item
 * drops out immediately; the parent clears the selection on success.
 */

interface ApprovalDetailPanelProps {
  approvalId: string;
  onResolved: () => void;
}

export function ApprovalDetailPanel({ approvalId, onResolved }: ApprovalDetailPanelProps) {
  const queryClient = useQueryClient();
  const detail = trpc.getApprovalRequest.useQuery(
    { approvalRequestId: approvalId },
    { staleTime: 10_000 },
  );

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const payload = detail.data?.proposedActionPayload ?? null;
  const draft = useMemo(() => (payload ? asDraftPayload(payload) : null), [payload]);

  // Seed the editable fields once the draft loads / changes.
  useEffect(() => {
    setSubject(draft?.subject ?? "");
    setBody(draft?.draft_text ?? "");
    setRejecting(false);
    setRejectReason("");
    setActionError(null);
  }, [draft, approvalId]);

  const invalidateQueue = () => {
    queryClient.invalidateQueries({ queryKey: [["listPendingApprovals"]] });
  };
  const onError = (err: { message: string }) => setActionError(err.message);

  const approve = trpc.approveApproval.useMutation({
    onSuccess: () => {
      invalidateQueue();
      onResolved();
    },
    onError,
  });
  const approveWithEdit = trpc.approveApprovalWithEdit.useMutation({
    onSuccess: () => {
      invalidateQueue();
      onResolved();
    },
    onError,
  });
  const reject = trpc.rejectApproval.useMutation({
    onSuccess: () => {
      invalidateQueue();
      onResolved();
    },
    onError,
  });
  const snooze = trpc.snoozeApproval.useMutation({
    onSuccess: () => {
      invalidateQueue();
      onResolved();
    },
    onError,
  });

  const busy =
    approve.isPending ||
    approveWithEdit.isPending ||
    reject.isPending ||
    snooze.isPending;

  if (detail.isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading approval…</div>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="p-6 text-sm text-red-600">
        Couldn’t load this approval. It may have already been resolved.
      </div>
    );
  }

  const d = detail.data;

  // Has the recruiter changed the draft? Drives approve vs approve-with-edit.
  const edited =
    draft !== null && (subject !== (draft.subject ?? "") || body !== (draft.draft_text ?? ""));

  function onApprove() {
    setActionError(null);
    if (draft && edited) {
      // Replace the whole payload so send_message reads the edited text.
      approveWithEdit.mutate({
        approvalRequestId: approvalId,
        editedPayload: { ...payload, subject, draft_text: body },
      });
    } else {
      approve.mutate({ approvalRequestId: approvalId });
    }
  }

  function onReject() {
    setActionError(null);
    if (rejectReason.trim().length === 0) {
      setActionError("A rejection reason is required.");
      return;
    }
    reject.mutate({ approvalRequestId: approvalId, decisionNotes: rejectReason.trim() });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-neutral-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">{d.agentName}</h2>
            <p className="text-sm text-neutral-500">{d.proposedActionSummary}</p>
          </div>
          <div className="text-right text-xs text-neutral-500">
            <div>proposed {timeAgo(d.proposedAt)}</div>
            <div>cost so far {formatCostMicros(d.costMicrosSoFar)}</div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {draft ? (
          <div className="space-y-5">
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
                To
              </div>
              <div className="text-sm text-neutral-800">
                {draft.candidate_name ? `${draft.candidate_name} · ` : ""}
                {draft.candidate_email ?? "(no recipient)"}
              </div>
              {draft.position_title ? (
                <div className="text-xs text-neutral-500">
                  re: {draft.position_title}
                  {draft.company_name ? ` at ${draft.company_name}` : ""}
                </div>
              ) : null}
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
                Subject
              </span>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={busy}
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
                Message {edited ? <span className="text-brand-600">· edited</span> : null}
              </span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={busy}
                rows={12}
                className="w-full resize-y rounded-md border border-neutral-300 px-3 py-2 font-mono text-sm leading-relaxed focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </label>
            <p className="text-xs text-neutral-400">
              Drafted by {d.agentName}. Edit before approving and your version is what gets sent.
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Proposed action ({d.actionType})
            </div>
            <pre className="overflow-x-auto rounded-md bg-neutral-50 p-3 text-xs text-neutral-700">
              {JSON.stringify(d.proposedActionPayload, null, 2)}
            </pre>
            <p className="mt-2 text-xs text-neutral-400">
              This action type has no tailored review UI yet — approve, reject, or snooze below.
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="border-t border-neutral-200 px-6 py-4">
        {actionError ? (
          <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </div>
        ) : null}

        {rejecting ? (
          <div className="space-y-3">
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={busy}
              rows={2}
              placeholder="Why are you rejecting this? (required — recorded in the audit log)"
              className="w-full resize-y rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
            <div className="flex gap-2">
              <Button variant="destructive" onClick={onReject} disabled={busy}>
                Confirm reject
              </Button>
              <Button variant="tertiary" onClick={() => setRejecting(false)} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={onApprove} disabled={busy}>
              {edited ? "Approve edited" : "Approve & send"}
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(true)} disabled={busy}>
              Reject
            </Button>
            <Button
              variant="tertiary"
              onClick={() => snooze.mutate({ approvalRequestId: approvalId })}
              disabled={busy}
            >
              Snooze 24h
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
