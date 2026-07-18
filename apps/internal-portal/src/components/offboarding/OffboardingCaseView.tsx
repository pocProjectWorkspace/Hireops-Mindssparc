"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AssetReturnRow,
  AssetReturnStatus,
  ExitInterviewRow,
  FinalSettlementRow,
  FinalSettlementStatus,
  GetOffboardingCaseDetailOutput,
  OffboardingCaseDetail,
  OffboardingTaskRow,
  OffboardingTaskStatus,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import {
  ASSET_STATUS_META,
  ASSET_STATUS_OPTIONS,
  CASE_STATUS_META,
  INITIATION_TYPE_META,
  SETTLEMENT_STATUS_META,
  TASK_GROUPS,
  TASK_STATUS_META,
  caseStatusActions,
  formatDate,
  formatMoney,
  groupForTaskType,
  isTaskResolved,
  settlementActions,
} from "./offboarding-format";

// `metadata` / `structuredResponses` / `breakdown` are z.unknown() fields whose
// key-optionality differs between the direct schema infer and tRPC's router-
// output infer; relaxing them to optional here reconciles both (same trick the
// onboarding surface uses for task metadata). Nothing is lost — we read them as
// unknown.
type TaskItem = Omit<OffboardingTaskRow, "metadata"> & { metadata?: unknown };
type ExitInterviewItem = Omit<ExitInterviewRow, "structuredResponses"> & {
  structuredResponses?: unknown;
};
type SettlementItem = Omit<FinalSettlementRow, "breakdown"> & { breakdown?: unknown };

/** Shared React-Query invalidation for every offboarding mutation. */
function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: [["getOffboardingCaseDetail"]] });
    queryClient.invalidateQueries({ queryKey: [["listOffboardingCases"]] });
  };
}

/**
 * Offboarding case detail — HR's working surface for one departure.
 *
 * Header carries the who/why/when (employee, initiation type, notice + last
 * working day, reason, manager, initiator) plus the status chip and the single
 * gated forward action, whose disabled state names exactly what's missing
 * ("complete access revocation, record asset returns"). Below, the clearance
 * checklist grouped into knowledge transfer / assets & access / clearance &
 * settlement, each task actionable. Then the assets section (record/update
 * returns — all-returned auto-completes the task), the exit interview (a
 * structured shortform + free text, submit-once then frozen), and the final
 * settlement walk (pending → calculated → approved → paid, with the
 * access-revocation gate visible on the approve step). Once completed, the
 * Workday terminate line stands in — honest that it's simulated.
 *
 * Seeded from the server render and kept live by React Query; each mutation
 * invalidates the detail + list queries so the header and chips re-render.
 */
export function OffboardingCaseView({
  caseId,
  initial,
}: {
  caseId: string;
  initial: GetOffboardingCaseDetailOutput;
}) {
  const query = trpc.getOffboardingCaseDetail.useQuery(
    { caseId },
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );

  const data = query.data ?? initial;
  const c = data.case;
  const tasks: TaskItem[] = data.tasks;
  const meta = CASE_STATUS_META[c.status];

  const total = tasks.length;
  const done = tasks.filter((t) => isTaskResolved(t.status)).length;

  const accessRevoked = tasks.some(
    (t) => t.taskType === "access_revocation" && t.status === "completed",
  );
  const assetsReturned = tasks.some(
    (t) => t.taskType === "asset_return" && t.status === "completed",
  );
  const settlementReady =
    data.settlement != null &&
    (data.settlement.status === "approved" || data.settlement.status === "paid");

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6">
      <a
        href="/offboarding"
        className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-500 transition-colors hover:text-neutral-800"
      >
        <span aria-hidden>&larr;</span> All offboarding cases
      </a>

      {/* Header */}
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="truncate text-lg font-semibold text-neutral-900">
                {c.candidateName ?? "Employee"}
              </h2>
              <Badge tone="neutral">{INITIATION_TYPE_META[c.initiationType].label}</Badge>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>
            <p className="mt-0.5 text-sm text-neutral-600">{c.reason ?? "No reason recorded"}</p>
          </div>
          <div className="shrink-0 text-right text-sm">
            <div className="text-xs uppercase tracking-wide text-neutral-400">Clearance</div>
            <div className="tabular-nums font-semibold text-neutral-800">
              {done}/{total} done
            </div>
          </div>
        </div>

        <CaseDetails c={c} />

        <TerminateStatus c={c} />

        <CaseStatusActions
          caseId={caseId}
          gate={{
            status: c.status,
            lastWorkingDay: c.lastWorkingDay,
            accessRevoked,
            assetsReturned,
            settlementReady,
          }}
        />
      </Card>

      {/* Checklist */}
      <Checklist tasks={tasks} />

      {/* Assets & access */}
      <AssetsSection caseId={caseId} assets={data.assetReturns} />

      {/* Exit interview */}
      <ExitInterviewSection caseId={caseId} interview={data.exitInterview} />

      {/* Final settlement */}
      <SettlementSection
        caseId={caseId}
        settlement={data.settlement}
        accessRevoked={accessRevoked}
      />
    </div>
  );
}

// ─────────────── header details ───────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-neutral-800">{children}</dd>
    </div>
  );
}

function CaseDetails({ c }: { c: OffboardingCaseDetail }) {
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
      <Field label="Notice start">{formatDate(c.noticeStartDate)}</Field>
      <Field label="Last working day">{formatDate(c.lastWorkingDay)}</Field>
      <Field label="Initiation type">{INITIATION_TYPE_META[c.initiationType].label}</Field>
      <Field label="Manager">{c.managerName ?? c.managerEmail ?? "Not assigned"}</Field>
      <Field label="Initiated by">{c.initiatedByName ?? "—"}</Field>
    </dl>
  );
}

// ─────────────── Workday terminate (OFFBOARD-02 sim) ───────────────

/**
 * The departure's Workday moment. Advancing a case to completed enqueues the
 * idempotent terminate_employee event to the same outbox the hire path uses
 * (OFFBOARD-02). There is no case-side terminate write-back column yet (a later
 * ticket — see the offboarding-case lib), so once completed we show the
 * termination as sent — honest that it's simulated, matching the onboarding
 * "Hired in Workday · simulated" voice.
 */
function TerminateStatus({ c }: { c: OffboardingCaseDetail }) {
  if (c.status !== "completed") return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-4">
      <Badge tone="success">Terminated in Workday</Badge>
      <span className="text-xs text-neutral-500">
        Termination effective {formatDate(c.lastWorkingDay)}
        <span className="text-neutral-400"> · simulated</span>
      </span>
    </div>
  );
}

// ─────────────── case status action (gated advance) ───────────────

function CaseStatusActions({
  caseId,
  gate,
}: {
  caseId: string;
  gate: Parameters<typeof caseStatusActions>[0];
}) {
  const invalidate = useInvalidate();
  const [error, setError] = useState<string | null>(null);
  const [lwdDraft, setLwdDraft] = useState<string>("");
  const [settingLwd, setSettingLwd] = useState(false);
  const actions = caseStatusActions(gate);

  const mutation = trpc.advanceOffboardingCase.useMutation({
    onSuccess: () => {
      invalidate();
      setSettingLwd(false);
      setLwdDraft("");
    },
    onError: (e) => setError(e.message),
  });

  if (actions.length === 0) return null;

  function advance(target: (typeof actions)[number]["status"], extra?: Record<string, unknown>) {
    setError(null);
    mutation.mutate({ caseId, targetStatus: target, ...extra });
  }

  function onCancel() {
    const reason = window.prompt(
      "Why is this offboarding being cancelled? (recorded in the audit log)",
    );
    if (reason == null) return;
    if (reason.trim().length === 0) {
      setError("A reason is required to cancel.");
      return;
    }
    advance("cancelled", { reason: reason.trim() });
  }

  const busy = mutation.isPending;

  return (
    <div className="mt-5 border-t border-neutral-100 pt-4">
      {error ? (
        <div className="mb-3 rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-3">
        {actions.map((a) => {
          if (a.kind === "cancel") {
            return (
              <Button
                key={a.status}
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={onCancel}
                className="text-status-error-700 hover:border-status-error-300 hover:bg-status-error-50 hover:text-status-error-800"
              >
                {a.label}
              </Button>
            );
          }
          // → clearance with no LWD yet: collect it inline rather than dead-end
          // on a disabled button (advanceOffboardingCase accepts the date).
          if (a.status === "clearance" && !gate.lastWorkingDay) {
            return settingLwd ? (
              <div key={a.status} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={lwdDraft}
                    disabled={busy}
                    onChange={(e) => setLwdDraft(e.target.value)}
                    className="h-8 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !lwdDraft.trim()}
                    onClick={() => advance("clearance", { lastWorkingDay: lwdDraft.trim() })}
                  >
                    Set date &amp; advance
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setSettingLwd(false)}
                  >
                    Cancel
                  </Button>
                </div>
                <span className="text-xs text-neutral-500">
                  Set the last working day to move to clearance.
                </span>
              </div>
            ) : (
              <Button
                key={a.status}
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => setSettingLwd(true)}
              >
                {a.label}
              </Button>
            );
          }
          return (
            <div key={a.status} className="flex flex-col gap-1">
              <Button
                variant="primary"
                size="sm"
                disabled={busy || a.disabled}
                onClick={() => advance(a.status)}
              >
                {a.label}
              </Button>
              {a.disabled && a.reason ? (
                <span className="max-w-xs text-xs text-neutral-500">{a.reason}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────── checklist ───────────────

function Checklist({ tasks }: { tasks: TaskItem[] }) {
  const grouped = new Map<string, { title: string; tasks: TaskItem[] }>();
  for (const task of tasks) {
    const group = groupForTaskType(task.taskType);
    const bucket = grouped.get(group.key) ?? { title: group.title, tasks: [] };
    bucket.tasks.push(task);
    grouped.set(group.key, bucket);
  }
  const orderedKeys = [...TASK_GROUPS.map((g) => g.key), "other"];
  const sections = orderedKeys
    .map((key) => grouped.get(key))
    .filter((s): s is { title: string; tasks: TaskItem[] } => s !== undefined);

  if (sections.length === 0) {
    return (
      <Card>
        <EmptyState className="py-8" title="No checklist tasks" hint="This case has no tasks." />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {sections.map((section) => {
        const done = section.tasks.filter((t) => isTaskResolved(t.status)).length;
        return (
          <section key={section.title}>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-neutral-800">{section.title}</h3>
              <span className="text-xs tabular-nums text-neutral-400">
                {done}/{section.tasks.length}
              </span>
            </div>
            <Card padded={false}>
              <ul className="divide-y divide-neutral-100">
                {section.tasks.map((task) => (
                  <li key={task.id}>
                    <TaskRow task={task} />
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({ task }: { task: TaskItem }) {
  const invalidate = useInvalidate();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const meta = TASK_STATUS_META[task.status];

  const mutation = trpc.updateOffboardingTaskStatus.useMutation({
    onSuccess: () => {
      invalidate();
      setBlocking(false);
      setReason("");
    },
    onError: (e) => setError(e.message),
  });

  function setStatus(status: OffboardingTaskStatus, blockedReason?: string) {
    setError(null);
    mutation.mutate({ taskId: task.id, status, blockedReason });
  }

  function confirmBlock() {
    if (reason.trim().length === 0) {
      setError("A reason is required to block a task.");
      return;
    }
    setStatus("blocked", reason.trim());
  }

  const busy = mutation.isPending;

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-900">{task.title}</span>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          {task.status === "blocked" && task.blockedReason ? (
            <p className="mt-1 text-xs text-status-error-700">Blocked: {task.blockedReason}</p>
          ) : null}
          {task.dueAt ? (
            <p className="mt-1 text-xs text-neutral-400">Due {formatDate(task.dueAt)}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {task.status !== "completed" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setStatus("completed")}
            >
              Complete
            </Button>
          ) : null}
          {task.status !== "blocked" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                setBlocking((v) => !v);
              }}
            >
              Block
            </Button>
          ) : null}
          {task.status !== "skipped" && task.status !== "completed" ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus("skipped")}>
              Skip
            </Button>
          ) : null}
          {isTaskResolved(task.status) || task.status === "blocked" ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setStatus("pending")}>
              Reopen
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p className="mt-2 text-xs text-status-error-700">{error}</p> : null}

      {blocking ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            rows={2}
            placeholder="Why is this blocked? (required — recorded in the audit log)"
            className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
          />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={busy} onClick={confirmBlock}>
              Confirm block
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBlocking(false);
                setReason("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────── assets ───────────────

function AssetsSection({ caseId, assets }: { caseId: string; assets: AssetReturnRow[] }) {
  const invalidate = useInvalidate();
  const [adding, setAdding] = useState(false);
  const [assetType, setAssetType] = useState("");
  const [assetTag, setAssetTag] = useState("");
  const [status, setStatus] = useState<AssetReturnStatus>("returned");
  const [error, setError] = useState<string | null>(null);

  const recordMutation = trpc.recordAssetReturn.useMutation({
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setAssetType("");
      setAssetTag("");
      setStatus("returned");
    },
    onError: (e) => setError(e.message),
  });

  function add() {
    if (assetType.trim().length === 0) {
      setError("Name the asset (e.g. Laptop).");
      return;
    }
    setError(null);
    recordMutation.mutate({
      caseId,
      assetType: assetType.trim(),
      assetTag: assetTag.trim() || undefined,
      status,
    });
  }

  const busy = recordMutation.isPending;

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-800">Company assets</h3>
        <Button variant="ghost" size="sm" onClick={() => setAdding((v) => !v)}>
          {adding ? "Close" : "Record asset"}
        </Button>
      </div>

      {adding ? (
        <Card className="mb-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="text-xs uppercase tracking-wide text-neutral-400">Asset</span>
              <input
                value={assetType}
                disabled={busy}
                onChange={(e) => setAssetType(e.target.value)}
                placeholder="Laptop, ID card, phone…"
                className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs uppercase tracking-wide text-neutral-400">Tag / serial</span>
              <input
                value={assetTag}
                disabled={busy}
                onChange={(e) => setAssetTag(e.target.value)}
                placeholder="Optional"
                className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs uppercase tracking-wide text-neutral-400">Status</span>
              <select
                value={status}
                disabled={busy}
                onChange={(e) => setStatus(e.target.value as AssetReturnStatus)}
                className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              >
                {ASSET_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error ? <p className="mt-2 text-xs text-status-error-700">{error}</p> : null}
          <div className="mt-3">
            <Button variant="primary" size="sm" disabled={busy} onClick={add}>
              {busy ? "Recording…" : "Record"}
            </Button>
          </div>
        </Card>
      ) : null}

      {assets.length === 0 ? (
        <Card>
          <EmptyState
            className="py-8"
            title="No assets recorded"
            hint="Record each company asset as it's returned. When all are returned or written off, the asset-return task completes itself."
          />
        </Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-neutral-100">
            {assets.map((a) => (
              <li key={a.id}>
                <AssetRow asset={a} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function AssetRow({ asset }: { asset: AssetReturnRow }) {
  const invalidate = useInvalidate();
  const [error, setError] = useState<string | null>(null);
  const meta = ASSET_STATUS_META[asset.status];

  const mutation = trpc.updateAssetReturn.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  function setStatus(status: AssetReturnStatus) {
    setError(null);
    mutation.mutate({ assetReturnId: asset.id, status });
  }

  const busy = mutation.isPending;

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-900">{asset.assetType}</span>
            {asset.assetTag ? (
              <span className="truncate font-mono text-xs text-neutral-400">{asset.assetTag}</span>
            ) : null}
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          {asset.returnedAt ? (
            <p className="mt-0.5 text-xs text-neutral-500">
              Returned {formatDate(asset.returnedAt)}
            </p>
          ) : null}
          {asset.notes ? <p className="mt-0.5 text-xs text-neutral-500">{asset.notes}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {asset.status !== "returned" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setStatus("returned")}
            >
              Mark returned
            </Button>
          ) : null}
          {asset.status !== "written_off" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setStatus("written_off")}
            >
              Write off
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <p className="mt-2 text-xs text-status-error-700">{error}</p> : null}
    </div>
  );
}

// ─────────────── exit interview ───────────────

function ExitInterviewSection({
  caseId,
  interview,
}: {
  caseId: string;
  interview: ExitInterviewItem | null;
}) {
  const invalidate = useInvalidate();
  const submitted = interview?.submittedAt != null;

  const responses = (interview?.structuredResponses ?? {}) as Record<string, unknown>;
  const [rating, setRating] = useState<string>(
    typeof responses.rating === "number" ? String(responses.rating) : "",
  );
  const [recommend, setRecommend] = useState<string>(
    typeof responses.wouldRecommend === "boolean" ? (responses.wouldRecommend ? "yes" : "no") : "",
  );
  const [scheduledAt, setScheduledAt] = useState<string>(
    interview?.scheduledAt ? interview.scheduledAt.slice(0, 16) : "",
  );
  const [freeText, setFreeText] = useState<string>(interview?.freeText ?? "");
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.recordExitInterview.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  function payload(submit: boolean) {
    const structured: Record<string, unknown> = {};
    if (rating) structured.rating = Number(rating);
    if (recommend) structured.wouldRecommend = recommend === "yes";
    return {
      caseId,
      scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      structuredResponses: structured,
      freeText: freeText.trim() || null,
      submit,
    };
  }

  function save(submit: boolean) {
    setError(null);
    if (
      submit &&
      !window.confirm("Submit the exit interview? Once submitted it can't be edited.")
    ) {
      return;
    }
    mutation.mutate(payload(submit));
  }

  const busy = mutation.isPending;

  return (
    <section className="mt-8">
      <h3 className="mb-2 text-sm font-semibold text-neutral-800">Exit interview</h3>
      <Card>
        {submitted ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge tone="success">Submitted</Badge>
              <span className="text-xs text-neutral-500">
                {formatDate(interview?.submittedAt)} · now immutable
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 pt-1 text-sm sm:grid-cols-3">
              <Field label="Overall rating">
                {typeof responses.rating === "number" ? `${responses.rating}/5` : "—"}
              </Field>
              <Field label="Would recommend">
                {typeof responses.wouldRecommend === "boolean"
                  ? responses.wouldRecommend
                    ? "Yes"
                    : "No"
                  : "—"}
              </Field>
              <Field label="Scheduled">{formatDate(interview?.scheduledAt)}</Field>
            </dl>
            {interview?.freeText ? (
              <p className="whitespace-pre-wrap pt-1 text-sm text-neutral-700">
                {interview.freeText}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <label className="text-sm">
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  Scheduled for
                </span>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  disabled={busy}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
                />
              </label>
              <label className="text-sm">
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  Overall rating
                </span>
                <select
                  value={rating}
                  disabled={busy}
                  onChange={(e) => setRating(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
                >
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} / 5
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  Would recommend
                </span>
                <select
                  value={recommend}
                  disabled={busy}
                  onChange={(e) => setRecommend(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
                >
                  <option value="">—</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-xs uppercase tracking-wide text-neutral-400">Notes</span>
              <textarea
                value={freeText}
                disabled={busy}
                rows={3}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="What went well, what could improve, reason for leaving…"
                className="mt-1 w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              />
            </label>
            {error ? <p className="text-xs text-status-error-700">{error}</p> : null}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => save(false)}>
                Save draft
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => save(true)}>
                Submit exit interview
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}

// ─────────────── final settlement ───────────────

function SettlementSection({
  caseId,
  settlement,
  accessRevoked,
}: {
  caseId: string;
  settlement: SettlementItem | null;
  accessRevoked: boolean;
}) {
  const invalidate = useInvalidate();
  const [amount, setAmount] = useState<string>(
    settlement?.amountMinor != null ? String(settlement.amountMinor / 100) : "",
  );
  const [currency, setCurrency] = useState<string>(settlement?.currency ?? "INR");
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.updateFinalSettlement.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });

  const status: FinalSettlementStatus | null = settlement?.status ?? null;
  const actions = settlementActions(status, accessRevoked);
  const meta = status ? SETTLEMENT_STATUS_META[status] : null;

  function walk(target: FinalSettlementStatus) {
    setError(null);
    const amountMinor =
      amount.trim() && Number.isFinite(Number(amount))
        ? Math.round(Number(amount) * 100)
        : undefined;
    mutation.mutate({
      caseId,
      status: target,
      amountMinor,
      currency: currency.trim() ? currency.trim().toUpperCase() : undefined,
    });
  }

  const busy = mutation.isPending;
  const breakdown =
    settlement?.breakdown && typeof settlement.breakdown === "object"
      ? (settlement.breakdown as Record<string, unknown>)
      : null;

  return (
    <section className="mt-8">
      <h3 className="mb-2 text-sm font-semibold text-neutral-800">Full &amp; final settlement</h3>
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {meta ? (
              <Badge tone={meta.tone}>{meta.label}</Badge>
            ) : (
              <Badge tone="neutral">Not started</Badge>
            )}
            {settlement?.paidAt ? (
              <span className="text-xs text-neutral-500">Paid {formatDate(settlement.paidAt)}</span>
            ) : null}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-neutral-400">Net amount</div>
            <div className="tabular-nums text-sm font-semibold text-neutral-800">
              {formatMoney(settlement?.amountMinor ?? null, settlement?.currency ?? currency)}
            </div>
          </div>
        </div>

        {breakdown ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-neutral-100 pt-3 text-sm sm:grid-cols-3">
            {Object.entries(breakdown).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="truncate text-xs uppercase tracking-wide text-neutral-400">
                  {k.replace(/_/g, " ")}
                </dt>
                <dd className="tabular-nums text-neutral-800">
                  {typeof v === "number"
                    ? formatMoney(v, settlement?.currency ?? currency)
                    : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {status !== "paid" ? (
          <div className="mt-4 border-t border-neutral-100 pt-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm">
                <span className="text-xs uppercase tracking-wide text-neutral-400">
                  Net amount ({currency || "INR"})
                </span>
                <input
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 245000"
                  className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
                />
              </label>
              <label className="text-sm">
                <span className="text-xs uppercase tracking-wide text-neutral-400">Currency</span>
                <input
                  value={currency}
                  disabled={busy}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  className="mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm uppercase focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
                />
              </label>
            </div>
            {error ? <p className="mt-2 text-xs text-status-error-700">{error}</p> : null}
            <div className="mt-3 flex flex-wrap items-start gap-x-2 gap-y-2">
              {actions.length === 0 ? (
                <span className="text-xs text-neutral-500">Settlement is fully paid.</span>
              ) : (
                actions.map((a) => (
                  <div key={a.target} className="flex flex-col gap-1">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || a.disabled}
                      onClick={() => walk(a.target)}
                    >
                      {a.label}
                    </Button>
                    {a.disabled && a.reason ? (
                      <span className="max-w-xs text-xs text-neutral-500">{a.reason}</span>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
