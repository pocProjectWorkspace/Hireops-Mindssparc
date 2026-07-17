"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { GetRequisitionDetailOutput } from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Badge, Button, Card } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { InterviewPlanSection } from "@/components/interviews/InterviewPlanSection";

/**
 * REQ-02 — requisition detail view. Renders the requisition summary, JD,
 * skills, knockouts and approval state, and — while the requisition is a draft
 * and the caller can write — offers "Continue editing" (back into the wizard)
 * and "Submit for approval". Submission transitions draft → pending_approval
 * and refreshes the page to show the new approval state.
 */

const REQ_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "success",
  on_hold: "warning",
  posted: "info",
  filled: "success",
  cancelled: "error",
  closed: "neutral",
};

const APPROVAL_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  approved: "success",
  rejected: "error",
  cancelled: "neutral",
  expired: "neutral",
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const reasonCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

type DecisionKind = "approve" | "send_back" | "reject";

export function RequisitionDetailView({
  requisitionId,
  initial,
  canWrite,
  canDecide,
  canPost,
  canManageInterviews,
}: {
  requisitionId: string;
  initial: GetRequisitionDetailOutput;
  canWrite: boolean;
  canDecide: boolean;
  canPost: boolean;
  canManageInterviews: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const detail = trpc.getRequisitionDetail.useQuery({ requisitionId }, { initialData: initial });
  const submit = trpc.submitRequisitionForApproval.useMutation();
  const decide = trpc.decideRequisitionApproval.useMutation();
  const post = trpc.postRequisition.useMutation();
  const r = detail.data ?? initial;

  async function onSubmit() {
    setError(null);
    setNotice(null);
    try {
      const res = await submit.mutateAsync({ requisitionId });
      if (res.alreadySubmitted) {
        setNotice("This requisition was already submitted for approval.");
      }
      await detail.refetch();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onDecide(decision: DecisionKind) {
    setError(null);
    setNotice(null);
    const trimmed = reason.trim();
    if ((decision === "send_back" || decision === "reject") && trimmed.length === 0) {
      setError(
        decision === "reject"
          ? "A reason is required to reject a requisition."
          : "A reason is required to send a requisition back.",
      );
      return;
    }
    if (decision === "reject") {
      const ok = window.confirm(
        "Reject this requisition? This closes it — the hiring manager cannot resubmit it. Send it back instead if revisions could fix it.",
      );
      if (!ok) return;
    }
    const approvalRequestId = r.approval?.id;
    if (!approvalRequestId) {
      setError("No pending approval to decide.");
      return;
    }
    try {
      await decide.mutateAsync({
        approvalRequestId,
        decision,
        reason: trimmed.length > 0 ? trimmed : undefined,
      });
      setReason("");
      await detail.refetch();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  async function onPost() {
    setError(null);
    setNotice(null);
    try {
      await post.mutateAsync({ requisitionId });
      await detail.refetch();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  // The HR-head decision panel shows only while the approval is live.
  const canShowDecisionPanel =
    canDecide && r.status === "pending_approval" && r.approval?.status === "pending";
  // The hiring-manager banner: surface the latest HR-head verdict while the
  // req sits in the state that verdict produced (draft ← send_back,
  // cancelled ← reject). Cleared naturally once the HM resubmits.
  const sentBackBanner =
    r.latestDecision?.kind === "send_back" && r.status === "draft" ? r.latestDecision : null;
  const rejectedBanner =
    r.latestDecision?.kind === "reject" && r.status === "cancelled" ? r.latestDecision : null;
  const decidePending = decide.isPending;

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6 space-y-6">
      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-700">
          {notice}
        </div>
      ) : null}

      {/* Hiring-manager: HR-head verdict banner (send back / reject). */}
      {sentBackBanner ? (
        <div className="rounded-lg border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-700">
          <span className="font-semibold">Sent back by HR Head:</span>{" "}
          {sentBackBanner.reason ?? "No reason provided."}
          {canWrite ? (
            <span className="mt-1 block text-status-warning-600">
              Continue editing, then resubmit for approval.
            </span>
          ) : null}
        </div>
      ) : null}
      {rejectedBanner ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          <span className="font-semibold">Rejected by HR Head:</span>{" "}
          {rejectedBanner.reason ?? "No reason provided."}
        </div>
      ) : null}

      {/* Summary */}
      <Card>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-neutral-900">{r.title}</h2>
              <Badge tone={REQ_STATUS_TONE[r.status] ?? "neutral"}>{statusLabel(r.status)}</Badge>
            </div>
            <p className="mt-1 text-sm text-neutral-600">
              {r.department ?? "—"} · {r.primaryLocation ?? "—"} ({r.locationType})
              {r.seniority ? ` · ${r.seniority}` : ""}
            </p>
          </div>
          {canWrite && r.isDraft ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => router.push(`/requisitions/new?rid=${requisitionId}`)}
              >
                Continue editing
              </Button>
              <Button onClick={onSubmit} disabled={submit.isPending}>
                {submit.isPending ? "Submitting…" : "Submit for approval"}
              </Button>
            </div>
          ) : null}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <Meta label="Openings" value={String(r.numberOfOpenings)} />
          <Meta label="Target start" value={r.targetStartDate ?? "—"} />
          <Meta
            label="Comp band"
            value={
              r.compBandMin || r.compBandMax
                ? `${r.compBandMin ?? "?"}–${r.compBandMax ?? "?"} ${r.compCurrency ?? ""}`.trim()
                : "—"
            }
          />
        </dl>
      </Card>

      {/* Approval state */}
      <Card>
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">Approval</h3>
        {r.approval ? (
          <div className="flex items-center gap-3 text-sm">
            <Badge tone={APPROVAL_STATUS_TONE[r.approval.status] ?? "neutral"}>
              {statusLabel(r.approval.status)}
            </Badge>
            <span className="text-neutral-600">
              Requested {new Date(r.approval.requestedAt).toLocaleDateString("en-GB")}
              {r.approval.decidedAt
                ? ` · decided ${new Date(r.approval.decidedAt).toLocaleDateString("en-GB")}`
                : ""}
            </span>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            Not yet submitted.{" "}
            {canWrite && r.isDraft ? "Submit above when the draft is ready." : ""}
          </p>
        )}

        {/* HR-head decision form. */}
        {canShowDecisionPanel ? (
          <div className="mt-4 border-t border-neutral-200 pt-4">
            <p className="mb-2 text-sm font-semibold text-neutral-900">Your decision</p>
            <p className="mb-3 text-xs text-neutral-500">
              Review the requisition below. Approve to unlock posting, send back for revisions, or
              reject to close it. A reason is required to send back or reject.
            </p>
            <label
              htmlFor="decision-reason"
              className="mb-1 block text-xs font-medium text-neutral-700"
            >
              Reason <span className="text-neutral-400">(required to send back or reject)</span>
            </label>
            <textarea
              id="decision-reason"
              className={reasonCls}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Please tighten the required skills and confirm the comp band."
              disabled={decidePending}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => onDecide("approve")} disabled={decidePending}>
                {decidePending ? "Working…" : "Approve"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => onDecide("send_back")}
                disabled={decidePending}
              >
                Send back
              </Button>
              <Button variant="danger" onClick={() => onDecide("reject")} disabled={decidePending}>
                Reject
              </Button>
            </div>
          </div>
        ) : null}

        {/* Recruiter / hiring-manager: post an approved req live. */}
        {canPost && r.status === "approved" ? (
          <div className="mt-4 border-t border-neutral-200 pt-4">
            <p className="mb-2 text-sm text-neutral-700">
              Approved by the HR head. Post it to take the public apply page live.
            </p>
            <Button onClick={onPost} disabled={post.isPending}>
              {post.isPending ? "Posting…" : "Post requisition"}
            </Button>
          </div>
        ) : null}

        {/* Live public apply URL once posted. */}
        {r.status === "posted" && r.publicSlug ? (
          <div className="mt-4 border-t border-neutral-200 pt-4">
            <p className="mb-1 text-sm font-semibold text-neutral-900">Public apply page</p>
            <a
              href={`/t/${r.tenantSlug}/apply/${r.publicSlug}`}
              className="break-all text-sm text-brand-700 hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              /t/{r.tenantSlug}/apply/{r.publicSlug}
            </a>
          </div>
        ) : null}
      </Card>

      {/* JD */}
      <Card>
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">Job description</h3>
        {r.jdSections ? (
          <div className="space-y-3 text-sm text-neutral-800">
            <p>{r.jdSections.summary}</p>
            {r.jdSections.responsibilities.length > 0 ? (
              <div>
                <p className="font-medium text-neutral-700">Responsibilities</p>
                <ul className="mt-1 list-disc pl-5">
                  {r.jdSections.responsibilities.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {r.jdSections.requirements.length > 0 ? (
              <div>
                <p className="font-medium text-neutral-700">Requirements</p>
                <ul className="mt-1 list-disc pl-5">
                  {r.jdSections.requirements.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-neutral-700">{r.jdText}</p>
        )}
      </Card>

      {/* Skills */}
      <Card>
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">Skills</h3>
        {r.skills.length === 0 ? (
          <p className="text-sm text-neutral-500">No skills defined.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {r.skills.map((s) => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-700"
              >
                {s.skillName}
                {s.isRequired ? <span className="text-brand-600">· must-have</span> : null}
                <span className="text-neutral-400">w{s.weight}</span>
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* Knockouts */}
      <Card>
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">Knockouts</h3>
        {r.knockouts.length === 0 ? (
          <p className="text-sm text-neutral-500">No knockouts defined.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {r.knockouts.map((k) => (
              <li key={k.id} className="flex items-start gap-2">
                <Badge tone="neutral">{k.type}</Badge>
                <span className="text-neutral-800">{k.questionText}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Interview rounds (INT-02). Editable while the req isn't terminal. */}
      <InterviewPlanSection
        requisitionId={requisitionId}
        canManage={canManageInterviews && !["cancelled", "closed"].includes(r.status)}
      />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-neutral-900">{value}</dd>
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong. Please try again.";
}
