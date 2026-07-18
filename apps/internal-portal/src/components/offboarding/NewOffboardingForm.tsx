"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OffboardingInitiationType } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { INITIATION_TYPE_OPTIONS } from "./offboarding-format";

/** Radix-free select sentinel for "no manager". */
const UNASSIGNED = "__unassigned__";

/**
 * The initiate-offboarding form. Pick a hired employee (listHiredCandidates —
 * the offboarding lib's hired predicate, accepted offer OR onboarding case),
 * the initiation type, the notice + last-working-day dates, a reason, and the
 * reporting manager (listTenantMemberships). Submit calls initiateOffboarding,
 * which opens the case + generates the 7-task clearance checklist, then routes
 * to the new case detail.
 *
 * Employees who already have a live offboarding case are shown disabled — a
 * second initiation would 409 on the one-active-per-person guard.
 */
export function NewOffboardingForm() {
  const router = useRouter();
  const [candidateId, setCandidateId] = useState<string>("");
  const [initiationType, setInitiationType] = useState<OffboardingInitiationType>("resignation");
  const [noticeStartDate, setNoticeStartDate] = useState<string>("");
  const [lastWorkingDay, setLastWorkingDay] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [managerId, setManagerId] = useState<string>(UNASSIGNED);
  const [error, setError] = useState<string | null>(null);

  const hiredQuery = trpc.listHiredCandidates.useQuery({ limit: 200 }, { staleTime: 30_000 });
  const membersQuery = trpc.listTenantMemberships.useQuery(undefined, { staleTime: 60_000 });

  const mutation = trpc.initiateOffboarding.useMutation({
    onSuccess: (res) => router.push(`/offboarding/${res.caseId}`),
    onError: (e) => setError(e.message),
  });

  const hired = hiredQuery.data?.items ?? [];
  const members = membersQuery.data?.items ?? [];
  const selectable = hired.filter((h) => !h.hasActiveOffboardingCase);

  function submit() {
    setError(null);
    if (!candidateId) {
      setError("Choose an employee to offboard.");
      return;
    }
    mutation.mutate({
      candidateId,
      initiationType,
      noticeStartDate: noticeStartDate.trim() || undefined,
      lastWorkingDay: lastWorkingDay.trim() || undefined,
      reason: reason.trim() || undefined,
      managerMembershipId: managerId === UNASSIGNED ? undefined : managerId,
    });
  }

  const busy = mutation.isPending;

  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-6">
      <a
        href="/offboarding"
        className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-500 transition-colors hover:text-neutral-800"
      >
        <span aria-hidden>&larr;</span> All offboarding cases
      </a>

      <Card>
        <h2 className="text-lg font-semibold text-neutral-900">Initiate offboarding</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Open a departure case for a hired employee. This generates the clearance checklist —
          knowledge transfer, asset return, access revocation, final settlement and exit interview.
        </p>

        {hiredQuery.isLoading ? (
          <p className="mt-6 text-sm text-neutral-500">Loading employees…</p>
        ) : hired.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title="No hired employees yet"
              hint="Offboarding opens for someone who was actually hired — a candidate with an accepted offer or an onboarding case. Land an offer or start onboarding first, and they'll show up here."
            />
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            <Fieldset label="Employee">
              <select
                aria-label="Employee to offboard"
                value={candidateId}
                disabled={busy}
                onChange={(e) => setCandidateId(e.target.value)}
                className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              >
                <option value="">Select an employee…</option>
                {selectable.map((h) => (
                  <option key={h.candidateId} value={h.candidateId}>
                    {h.personName ?? h.email ?? h.candidateId.slice(0, 8)}
                    {h.onboardingStatus
                      ? ` — onboarding ${h.onboardingStatus.replace(/_/g, " ")}`
                      : ""}
                  </option>
                ))}
              </select>
              {hired.length > selectable.length ? (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                  <Badge tone="neutral">Already offboarding</Badge>
                  {hired
                    .filter((h) => h.hasActiveOffboardingCase)
                    .map((h) => h.personName ?? h.email ?? h.candidateId.slice(0, 8))
                    .join(", ")}
                </p>
              ) : null}
            </Fieldset>

            <Fieldset label="Initiation type">
              <select
                aria-label="Initiation type"
                value={initiationType}
                disabled={busy}
                onChange={(e) => setInitiationType(e.target.value as OffboardingInitiationType)}
                className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              >
                {INITIATION_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Fieldset>

            <div className="grid grid-cols-2 gap-4">
              <Fieldset label="Notice start">
                <DateInput value={noticeStartDate} disabled={busy} onChange={setNoticeStartDate} />
              </Fieldset>
              <Fieldset label="Last working day">
                <DateInput value={lastWorkingDay} disabled={busy} onChange={setLastWorkingDay} />
              </Fieldset>
            </div>

            <Fieldset label="Reason">
              <textarea
                value={reason}
                disabled={busy}
                rows={2}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Resignation reason, termination cause, or contract note (optional)."
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              />
            </Fieldset>

            <Fieldset label="Reporting manager">
              <select
                aria-label="Reporting manager"
                value={managerId}
                disabled={busy || membersQuery.isLoading}
                onChange={(e) => setManagerId(e.target.value)}
                className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-neutral-100"
              >
                <option value={UNASSIGNED}>Not assigned</option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.displayName ?? m.email ?? `Member ${m.membershipId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-neutral-500">
                The manager owns knowledge transfer and sign-off; HR owns the rest.
              </p>
            </Fieldset>

            {error ? (
              <p className="rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
                {error}
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={busy} onClick={submit}>
                {busy ? "Opening case…" : "Open offboarding case"}
              </Button>
              <a
                href="/offboarding"
                className="rounded-md px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                Cancel
              </a>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Fieldset({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-xs uppercase tracking-wide text-neutral-400">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function DateInput({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="date"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400"
    />
  );
}
