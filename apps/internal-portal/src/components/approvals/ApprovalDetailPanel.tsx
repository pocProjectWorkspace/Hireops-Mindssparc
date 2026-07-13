"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button } from "@/components/ui";
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
 * shown as a real email — recipient line, subject field, reading-width body —
 * with the editable state visually called out. Editing then approving routes
 * through approveApprovalWithEdit so the recruiter's text ships. Any other
 * action type falls back to a read-only JSON view until it gets its own UI.
 *
 * All four resolutions invalidate the queue list so the resolved item drops
 * out immediately; the parent clears the selection on success.
 */

interface ApprovalDetailPanelProps {
  approvalId: string;
  onResolved: () => void;
}

/** Human-readable label for a triggerContext key. */
function humanKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-sm text-neutral-800">{children}</dd>
    </div>
  );
}

const FIELD =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100";

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
    approve.isPending || approveWithEdit.isPending || reject.isPending || snooze.isPending;

  if (detail.isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading approval…</div>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="p-6 text-sm text-status-error-700">
        Couldn&rsquo;t load this approval. It may have already been resolved.
      </div>
    );
  }

  const d = detail.data;
  const triggerEntries = Object.entries(d.triggerContext ?? {});

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
    <div className="flex h-full flex-col bg-neutral-50">
      {/* Header */}
      <div className="border-b border-neutral-200 bg-white px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge tone="accent">{d.agentName}</Badge>
              <span className="text-xs uppercase tracking-wide text-neutral-400">
                {d.actionType.replace(/_/g, " ")}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-neutral-600">{d.proposedActionSummary}</p>
          </div>
          <div className="shrink-0 text-right text-xs text-neutral-500">
            <div>proposed {timeAgo(d.proposedAt)}</div>
            <div className="tabular-nums">cost so far {formatCostMicros(d.costMicrosSoFar)}</div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {draft ? (
          <div className="mx-auto max-w-2xl space-y-4">
            {/* The drafted email, presented as an email. */}
            <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-1">
              <div className="space-y-3 border-b border-neutral-200 px-5 py-4">
                <DefRow label="To">
                  {draft.candidate_name ? `${draft.candidate_name} · ` : ""}
                  {draft.candidate_email ?? "(no recipient)"}
                </DefRow>
                {draft.position_title ? (
                  <DefRow label="Re">
                    {draft.position_title}
                    {draft.company_name ? ` at ${draft.company_name}` : ""}
                  </DefRow>
                ) : null}
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Subject
                  </span>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    disabled={busy}
                    className={FIELD}
                  />
                </label>
              </div>
              <div className="px-5 py-4">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Message
                  </span>
                  {edited ? <Badge tone="accent">Edited</Badge> : null}
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={busy}
                  rows={12}
                  className={`${FIELD} resize-y font-mono leading-relaxed`}
                />
              </div>
            </div>
            <p className="text-xs text-neutral-400">
              Drafted by {d.agentName}. Edit before approving and your version is what gets sent.
            </p>

            {/* Trigger context — why the agent proposed this. */}
            {triggerEntries.length > 0 ? (
              <div className="rounded-lg border border-neutral-200 bg-white p-5">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Why this fired
                </h3>
                <dl className="divide-y divide-neutral-100">
                  {triggerEntries.map(([k, v]) => (
                    <DefRow key={k} label={humanKey(k)}>
                      {displayValue(v)}
                    </DefRow>
                  ))}
                </dl>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Proposed action ({d.actionType})
            </div>
            <pre className="overflow-x-auto rounded-md border border-neutral-200 bg-white p-3 text-xs text-neutral-700">
              {JSON.stringify(d.proposedActionPayload, null, 2)}
            </pre>
            <p className="mt-2 text-xs text-neutral-400">
              This action type has no tailored review UI yet — approve, reject, or snooze below.
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="border-t border-neutral-200 bg-white px-6 py-4">
        {actionError ? (
          <div className="mb-3 rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
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
              className={`${FIELD} resize-y`}
            />
            <div className="flex gap-2">
              <Button variant="danger" onClick={onReject} disabled={busy}>
                Confirm reject
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={onApprove} disabled={busy}>
              {edited ? "Approve edited & send" : "Approve & send"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setRejecting(true)}
              disabled={busy}
              className="text-status-error-700 hover:border-status-error-300 hover:bg-status-error-50 hover:text-status-error-800"
            >
              Reject
            </Button>
            <Button
              variant="ghost"
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
