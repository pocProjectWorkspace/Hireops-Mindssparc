"use client";

import { useMemo, useState } from "react";
import {
  type ApprovalMatrixRow,
  type ApprovalMatrixSubjectType,
  type ApprovalMatrixApproverRole,
  APPROVAL_MATRIX_APPROVER_ROLES,
  APPROVER_ROLE_LABELS,
} from "@hireops/api-types";
import { Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin Approval Routing (T1.3 / G13, option b).
 *
 * Lists the authored approval matrices grouped by subject type (requisition +
 * out-of-band offer), each showing its single approver role, effective window
 * and an "Active now" badge. A single form authors or edits ONE approver step:
 * who approves + when the policy takes effect. Multi-step routing is not authored
 * here — the decision spine only ever consults the first step, so a second step
 * would be a config-lie; it is labelled as planned instead.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

const SUBJECT_GROUPS: { key: ApprovalMatrixSubjectType; label: string; blurb: string }[] = [
  {
    key: "requisition",
    label: "Requisition approval",
    blurb: "Who signs off a requisition submitted for approval.",
  },
  {
    key: "offer",
    label: "Out-of-band offer approval",
    blurb: "Who signs off an offer that exceeds the role's comp band.",
  },
];

interface FormState {
  id?: string;
  subjectType: ApprovalMatrixSubjectType;
  name: string;
  approverRole: ApprovalMatrixApproverRole;
  effectiveFrom: string; // datetime-local
  effectiveTo: string; // datetime-local or ""
}

const EMPTY_FORM: FormState = {
  id: undefined,
  subjectType: "requisition",
  name: "",
  approverRole: "hr_head",
  effectiveFrom: "",
  effectiveTo: "",
};

export function ApprovalRoutingClient({ initial }: { initial: ApprovalMatrixRow[] }) {
  const utils = trpc.useUtils();
  const query = trpc.listApprovalMatrices.useQuery({}, { initialData: { matrices: initial } });
  const matrices = query.data?.matrices ?? initial;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const by: Record<ApprovalMatrixSubjectType, ApprovalMatrixRow[]> = {
      requisition: [],
      offer: [],
    };
    for (const m of matrices) by[m.subjectType]?.push(m);
    return by;
  }, [matrices]);

  const upsert = trpc.upsertApprovalMatrix.useMutation({
    onSuccess: async () => {
      await utils.listApprovalMatrices.invalidate();
      setError(null);
      setNotice(form.id ? "Approval policy updated." : "Approval policy added.");
      setForm(EMPTY_FORM);
    },
    onError: (err) => {
      setNotice(null);
      setError(`Save failed: ${err.message}`);
    },
  });

  function startNew(subjectType: ApprovalMatrixSubjectType) {
    setNotice(null);
    setError(null);
    setForm({ ...EMPTY_FORM, subjectType });
  }

  function startEdit(m: ApprovalMatrixRow) {
    setNotice(null);
    setError(null);
    const approverRole: ApprovalMatrixApproverRole =
      m.approverRole === "admin" ? "admin" : "hr_head";
    setForm({
      id: m.id,
      subjectType: m.subjectType,
      name: m.name,
      approverRole,
      effectiveFrom: toLocalInput(m.effectiveFrom),
      effectiveTo: m.effectiveTo ? toLocalInput(m.effectiveTo) : "",
    });
  }

  function onSave() {
    if (form.name.trim().length === 0) {
      setError("Give the policy a name.");
      return;
    }
    if (form.effectiveFrom.trim().length === 0) {
      setError("Choose an effective-from date.");
      return;
    }
    const from = new Date(form.effectiveFrom);
    const to = form.effectiveTo ? new Date(form.effectiveTo) : null;
    if (to && to.getTime() <= from.getTime()) {
      setError("The effective-to date must be after the effective-from date.");
      return;
    }
    setError(null);
    upsert.mutate({
      id: form.id,
      subjectType: form.subjectType,
      name: form.name.trim(),
      approverRole: form.approverRole,
      effectiveFrom: from.toISOString(),
      effectiveTo: to ? to.toISOString() : null,
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4">
        <p className="text-sm text-neutral-700">
          Choose who approves each chain and when the policy takes effect. Policies are{" "}
          <strong>effective-dated</strong> — the newest policy in force right now wins, and a
          future-dated policy schedules a change without touching today&apos;s routing. Each policy
          names a <strong>single approver</strong> today; multi-step routing (a sequence of
          approvers) is planned. Changing the approver here reroutes the next approval the platform
          raises.
        </p>
      </div>

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-positive-200 bg-status-positive-50 px-4 py-3 text-sm text-status-positive-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      <div className="space-y-6">
        {SUBJECT_GROUPS.map((group) => (
          <Card key={group.key} className="p-5">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900">{group.label}</h3>
                <p className="text-xs text-neutral-500">{group.blurb}</p>
              </div>
              <button
                type="button"
                className="shrink-0 text-xs text-brand-600 hover:underline"
                onClick={() => startNew(group.key)}
              >
                + Add policy
              </button>
            </div>

            {grouped[group.key].length === 0 ? (
              <p className="text-xs text-neutral-500">
                No policy authored. Until one is in force, the platform falls back to HR Head
                approval.
              </p>
            ) : (
              <div className="space-y-2">
                {grouped[group.key].map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-neutral-800">
                          {m.name}
                        </span>
                        {m.isActiveNow ? (
                          <Badge tone="success">Active now</Badge>
                        ) : (
                          <Badge tone="neutral">{scheduleLabel(m)}</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        Approver: <strong>{approverLabel(m.approverRole)}</strong> · Effective{" "}
                        {fmtDate(m.effectiveFrom)}
                        {m.effectiveTo ? ` – ${fmtDate(m.effectiveTo)}` : " onward"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-brand-600 hover:underline"
                      onClick={() => startEdit(m)}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* Single-approver editor */}
      <Card className="mt-6 p-5">
        <h3 className="mb-1 text-sm font-semibold text-neutral-900">
          {form.id ? "Edit approval policy" : "Add approval policy"}
        </h3>
        <p className="mb-4 text-xs text-neutral-500">
          One approver role per policy. Effective-date it to schedule a change ahead of time.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Chain</span>
            <select
              className={inputCls}
              value={form.subjectType}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  subjectType: e.target.value as ApprovalMatrixSubjectType,
                }))
              }
            >
              {SUBJECT_GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Approver role</span>
            <select
              className={inputCls}
              value={form.approverRole}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  approverRole: e.target.value as ApprovalMatrixApproverRole,
                }))
              }
            >
              {APPROVAL_MATRIX_APPROVER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {APPROVER_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>

          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Policy name</span>
            <input
              className={inputCls}
              value={form.name}
              placeholder="e.g. Requisition approval — HR Head"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600">Effective from</span>
            <input
              type="datetime-local"
              className={inputCls}
              value={form.effectiveFrom}
              onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-600">
              Effective to <span className="text-neutral-400">(optional)</span>
            </span>
            <input
              type="datetime-local"
              className={inputCls}
              value={form.effectiveTo}
              onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))}
            />
          </label>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <Button onClick={onSave} disabled={upsert.isPending}>
            {upsert.isPending ? "Saving…" : form.id ? "Save changes" : "Add policy"}
          </Button>
          {form.id || form.name || form.effectiveFrom ? (
            <button
              type="button"
              className="text-sm text-neutral-600 hover:underline"
              onClick={() => {
                setForm(EMPTY_FORM);
                setError(null);
                setNotice(null);
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function approverLabel(role: string): string {
  if (role === "hr_head") return APPROVER_ROLE_LABELS.hr_head;
  if (role === "admin") return APPROVER_ROLE_LABELS.admin;
  return role;
}

/** Whether a non-active matrix is scheduled (future) or expired (past). */
function scheduleLabel(m: ApprovalMatrixRow): string {
  const now = Date.now();
  if (new Date(m.effectiveFrom).getTime() > now) return "Scheduled";
  return "Expired";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** ISO → the `datetime-local` value (YYYY-MM-DDTHH:mm) in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
