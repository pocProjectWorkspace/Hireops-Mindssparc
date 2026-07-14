"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  GetOnboardingCaseDetailOutput,
  OnboardingCaseDetail,
  OnboardingCaseStatus,
  OnboardingTaskRow,
  OnboardingTaskStatus,
} from "@hireops/api-types";
import { Select } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import {
  CASE_STATUS_META,
  TASK_STATUS_META,
  TASK_GROUPS,
  GEOGRAPHY_OPTIONS,
  caseStatusActions,
  formatDate,
  formatGeography,
  groupForTaskType,
  isTaskResolved,
} from "./onboarding-format";

/** Select sentinel for "no buddy/manager" — Radix Select forbids "" values. */
const UNASSIGNED = "__unassigned__";

/**
 * Task shape as delivered by the detail query. `metadata` is a z.unknown()
 * field, whose key-optionality differs between the direct schema infer
 * (OnboardingTaskRow) and tRPC's router-output infer; relaxing it to
 * optional here reconciles both. We don't render metadata, so nothing is
 * lost.
 */
type TaskItem = Omit<OnboardingTaskRow, "metadata"> & { metadata?: unknown };

/**
 * Onboarding case detail — the recruiter's working surface for one hire.
 *
 * Header carries the who/where/when (candidate, requisition, geography,
 * expected/actual start, probation window, buddy/manager) plus the status
 * chip and the single forward-only status action allowed from here. Below,
 * the generated checklist grouped into document collection / IT & assets /
 * people & check-ins / probation, each task actionable: complete, reopen,
 * block (reason required — the API 400s without one), skip. A documents
 * section lists any collected files, or a quiet placeholder (upload is a
 * later ticket).
 *
 * Seeded from the server render (`initial`) and kept live by React Query; a
 * mutation invalidates the detail query so the header progress and task
 * chips reflect the change without a manual refresh.
 */
export function OnboardingCaseView({
  caseId,
  initial,
}: {
  caseId: string;
  initial: GetOnboardingCaseDetailOutput;
}) {
  const query = trpc.getOnboardingCaseDetail.useQuery(
    { caseId },
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );

  const data = query.data ?? initial;
  const { case: c, documents } = data;
  const tasks: TaskItem[] = data.tasks;
  const meta = CASE_STATUS_META[c.status];

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6">
      <a
        href="/onboarding"
        className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-500 transition-colors hover:text-neutral-800"
      >
        <span aria-hidden>&larr;</span> All onboarding cases
      </a>

      {/* Header */}
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="truncate text-lg font-semibold text-neutral-900">
                {c.candidateName ?? "Candidate"}
              </h2>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>
            <p className="mt-0.5 text-sm text-neutral-600">{c.positionTitle ?? "Requisition"}</p>
          </div>
          <div className="shrink-0 text-right text-sm">
            <div className="text-xs uppercase tracking-wide text-neutral-400">Checklist</div>
            <div className="tabular-nums font-semibold text-neutral-800">
              {done}/{total} done
            </div>
          </div>
        </div>

        <CaseDetailsEditor caseId={caseId} c={c} />

        <CaseStatusActions caseId={caseId} status={c.status} />
      </Card>

      {/* Checklist */}
      <Checklist tasks={tasks} />

      {/* Documents */}
      <section className="mt-8">
        <h3 className="mb-3 text-sm font-semibold text-neutral-800">Documents</h3>
        {documents.length === 0 ? (
          <Card>
            <EmptyState
              className="py-8"
              title="No documents collected yet"
              hint="Collected pre-boarding documents will appear here once uploads are enabled."
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <span className="min-w-0 truncate text-sm text-neutral-800">
                    {d.fileName ?? "Document"}
                  </span>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge tone="neutral">{d.verificationStatus.replace(/_/g, " ")}</Badge>
                    <span className="text-xs text-neutral-400">{formatDate(d.uploadedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-neutral-800">{children}</dd>
    </div>
  );
}

function EditField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="text-xs uppercase tracking-wide text-neutral-400">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ─────────────── editable case header (ONBOARD-04) ───────────────

/**
 * The who/where/when grid. Geography, expected start, buddy and manager are
 * editable inline; each edit calls updateOnboardingCase and invalidates the
 * detail + list queries. A geography change soft-adds the newly-applicable
 * document tasks server-side — we surface the returned count in a small
 * confirmation note. Buddy/manager options come from listTenantMemberships;
 * resolved names render once assigned.
 */
function CaseDetailsEditor({ caseId, c }: { caseId: string; c: OnboardingCaseDetail }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [startDraft, setStartDraft] = useState<string>(c.expectedStartDate ?? "");

  const membersQuery = trpc.listTenantMemberships.useQuery(undefined, {
    staleTime: 60_000,
  });
  const members = membersQuery.data?.items ?? [];

  const mutation = trpc.updateOnboardingCase.useMutation({
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: [["getOnboardingCaseDetail"]] });
      queryClient.invalidateQueries({ queryKey: [["listOnboardingCases"]] });
      if (res.documentTasksAdded > 0) {
        setNote(
          `Geography set to ${formatGeography(res.geographyCode)} — added ${res.documentTasksAdded} document task${
            res.documentTasksAdded === 1 ? "" : "s"
          }.`,
        );
      }
    },
    onError: (e) => setError(e.message),
  });

  function memberLabel(name: string | null, email: string | null, membershipId: string): string {
    return name ?? email ?? `Member ${membershipId.slice(0, 8)}`;
  }

  const memberOptions = [
    { value: UNASSIGNED, label: "Not assigned" },
    ...members.map((m) => ({
      value: m.membershipId,
      label: memberLabel(m.displayName, m.email, m.membershipId),
    })),
  ];

  function update(fields: Parameters<typeof mutation.mutate>[0]) {
    setError(null);
    setNote(null);
    mutation.mutate(fields);
  }

  const busy = mutation.isPending;
  const membersReady = !membersQuery.isLoading;

  return (
    <div className="mt-5">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <EditField label="Geography">
          <Select
            size="sm"
            value={c.geographyCode.toUpperCase()}
            options={GEOGRAPHY_OPTIONS}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== c.geographyCode.toUpperCase()) update({ caseId, geographyCode: value });
            }}
          />
        </EditField>

        <EditField label="Expected start">
          <input
            type="date"
            value={startDraft}
            disabled={busy}
            onChange={(e) => setStartDraft(e.target.value)}
            onBlur={() => {
              const next = startDraft.trim();
              if (next && next !== (c.expectedStartDate ?? "")) {
                update({ caseId, expectedStartDate: next });
              }
            }}
            className="h-8 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
          />
        </EditField>

        <Field label="Actual start">{formatDate(c.actualStartDate)}</Field>

        <EditField label="Buddy">
          <Select
            size="sm"
            value={c.buddyMembershipId ?? UNASSIGNED}
            options={memberOptions}
            disabled={busy || !membersReady}
            placeholder={membersReady ? "Assign a buddy…" : "Loading…"}
            onValueChange={(value) =>
              update({ caseId, buddyMembershipId: value === UNASSIGNED ? null : value })
            }
          />
          {c.buddyName || c.buddyEmail ? (
            <p className="mt-1 truncate text-xs text-neutral-500">
              {c.buddyName ?? c.buddyEmail}
              {c.buddyName && c.buddyEmail ? (
                <span className="text-neutral-400"> · {c.buddyEmail}</span>
              ) : null}
            </p>
          ) : null}
        </EditField>

        <EditField label="Manager">
          <Select
            size="sm"
            value={c.managerMembershipId ?? UNASSIGNED}
            options={memberOptions}
            disabled={busy || !membersReady}
            placeholder={membersReady ? "Assign a manager…" : "Loading…"}
            onValueChange={(value) =>
              update({ caseId, managerMembershipId: value === UNASSIGNED ? null : value })
            }
          />
          {c.managerName || c.managerEmail ? (
            <p className="mt-1 truncate text-xs text-neutral-500">
              {c.managerName ?? c.managerEmail}
              {c.managerName && c.managerEmail ? (
                <span className="text-neutral-400"> · {c.managerEmail}</span>
              ) : null}
            </p>
          ) : null}
        </EditField>

        <Field label="Probation">
          {c.probationDays} days
          {c.probationEndsAt ? (
            <span className="text-neutral-500"> · ends {formatDate(c.probationEndsAt)}</span>
          ) : null}
        </Field>
      </dl>

      {note ? (
        <p className="mt-3 rounded-md bg-status-success-50 px-3 py-2 text-sm text-status-success-700">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ─────────────── case status action ───────────────

function CaseStatusActions({ caseId, status }: { caseId: string; status: OnboardingCaseStatus }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const actions = caseStatusActions(status);

  const mutation = trpc.updateOnboardingCase.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [["getOnboardingCaseDetail"]] });
      queryClient.invalidateQueries({ queryKey: [["listOnboardingCases"]] });
    },
    onError: (e) => setError(e.message),
  });

  if (actions.length === 0) return null;

  function run(target: OnboardingCaseStatus, kind: "advance" | "cancel") {
    setError(null);
    if (
      kind === "cancel" &&
      !window.confirm("Cancel this onboarding case? This can't be undone.")
    ) {
      return;
    }
    mutation.mutate({ caseId, status: target });
  }

  return (
    <div className="mt-5 border-t border-neutral-100 pt-4">
      {error ? (
        <div className="mb-3 rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => (
          <Button
            key={a.status}
            variant={a.kind === "advance" ? "primary" : "secondary"}
            size="sm"
            disabled={mutation.isPending}
            onClick={() => run(a.status, a.kind)}
            className={
              a.kind === "cancel"
                ? "text-status-error-700 hover:border-status-error-300 hover:bg-status-error-50 hover:text-status-error-800"
                : undefined
            }
          >
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ─────────────── checklist ───────────────

function Checklist({ tasks }: { tasks: TaskItem[] }) {
  // Bucket tasks into their groups, preserving the canonical group order and
  // dropping groups with no tasks. Any unmapped type lands in "Other".
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
        <EmptyState
          className="py-8"
          title="No checklist tasks"
          hint="This case has no onboarding tasks."
        />
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
  const queryClient = useQueryClient();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const meta = TASK_STATUS_META[task.status];

  const mutation = trpc.updateOnboardingTaskStatus.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [["getOnboardingCaseDetail"]] });
      queryClient.invalidateQueries({ queryKey: [["listOnboardingCases"]] });
      setBlocking(false);
      setReason("");
    },
    onError: (e) => setError(e.message),
  });

  function setStatus(status: OnboardingTaskStatus, blockedReason?: string) {
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
          {task.description ? (
            <p className="mt-0.5 truncate text-xs text-neutral-500">{task.description}</p>
          ) : null}
          {task.status === "blocked" && task.blockedReason ? (
            <p className="mt-1 text-xs text-status-error-700">Blocked: {task.blockedReason}</p>
          ) : null}
          {task.dueAt ? (
            <p className="mt-1 text-xs text-neutral-400">Due {formatDate(task.dueAt)}</p>
          ) : null}
        </div>

        {/* Actions */}
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
