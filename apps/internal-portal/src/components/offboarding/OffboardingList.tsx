"use client";

import { useState } from "react";
import {
  offboardingCaseStatusSchema,
  type ListOffboardingCasesOutput,
  type OffboardingCaseListRow,
  type OffboardingCaseStatus,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Badge, DataBar, EmptyState } from "@/components/ui";
import { CASE_STATUS_META, INITIATION_TYPE_META, formatDate } from "./offboarding-format";

/**
 * The offboarding case list — one row per departure, filterable by case
 * status. Seeded from the server render (`initial`, the unfiltered first page)
 * and kept live by a React Query fetch keyed on the status filter so the screen
 * reflects clearance progress made in the detail view when a user navigates
 * back.
 *
 * A case only exists once HR initiates offboarding for a hired employee, so a
 * fresh demo DB lands here empty — the empty state teaches how a case comes to
 * be rather than just saying "nothing here". "Initiate offboarding" opens the
 * routed creation form.
 *
 * Rows deep-link to /offboarding/[caseId]; no drawer — the detail is a real
 * routed page so it can be shared.
 */

const STATUS_OPTIONS = offboardingCaseStatusSchema.options as readonly OffboardingCaseStatus[];

export function OffboardingList({ initial }: { initial: ListOffboardingCasesOutput }) {
  const [status, setStatus] = useState<OffboardingCaseStatus | undefined>(undefined);

  const query = trpc.listOffboardingCases.useQuery(
    { status, limit: 100 },
    {
      initialData: status === undefined ? initial : undefined,
      placeholderData: (prev) => prev,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  );

  const items = query.data?.items ?? [];
  const hasMore = query.data?.nextCursor != null;

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      {/* Action + filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a
          href="/offboarding/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          Initiate offboarding
        </a>
        <span className="ml-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
          Filter
        </span>
        <label className="flex items-center gap-1 text-sm">
          <span className="sr-only">Case status</span>
          <select
            aria-label="Filter by case status"
            value={status ?? ""}
            onChange={(e) =>
              setStatus((e.target.value || undefined) as OffboardingCaseStatus | undefined)
            }
            className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {CASE_STATUS_META[s].label}
              </option>
            ))}
          </select>
        </label>
        {status ? (
          <button
            type="button"
            onClick={() => setStatus(undefined)}
            className="rounded-md px-2 py-1 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            Clear filter
          </button>
        ) : null}
        <span className="ml-auto text-xs tabular-nums text-neutral-400">
          {items.length} case{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          {status ? (
            <EmptyState
              className="py-14"
              title={`No ${CASE_STATUS_META[status].label.toLowerCase()} cases`}
              hint="Nothing matches this status right now. Clear the filter to see every offboarding case."
            />
          ) : (
            <EmptyState
              className="py-14"
              title="No offboarding cases yet"
              hint="A departure case starts when HR initiates offboarding for a hired employee — resignation, termination or end of contract. It opens a clearance checklist (knowledge transfer, asset return, access revocation, final settlement, exit interview) that HR and the manager work through to a clean exit. Initiate offboarding for a hired employee to open the first case."
            />
          )}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((row) => (
            <li key={row.id}>
              <OffboardingRow row={row} />
            </li>
          ))}
        </ul>
      )}

      {hasMore ? (
        <p className="mt-4 text-center text-xs text-neutral-400">
          Showing the first {items.length}. Filter by status to narrow the list.
        </p>
      ) : null}
    </div>
  );
}

function OffboardingRow({ row }: { row: OffboardingCaseListRow }) {
  const meta = CASE_STATUS_META[row.status];
  const pct = row.totalTasks > 0 ? (row.completedTasks / row.totalTasks) * 100 : 0;

  return (
    <a
      href={`/offboarding/${row.id}`}
      className="block rounded-md border border-neutral-200 bg-white px-5 py-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-neutral-900">
              {row.candidateName ?? "Employee"}
            </p>
            <Badge tone="neutral">{INITIATION_TYPE_META[row.initiationType].label}</Badge>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-sm text-neutral-600">
            {row.reason ?? "No reason recorded"}
          </p>
        </div>
        <div className="shrink-0 text-right text-xs text-neutral-500">
          <div>
            Notice <span className="text-neutral-700">{formatDate(row.noticeStartDate)}</span>
          </div>
          <div className="mt-0.5">
            LWD <span className="text-neutral-700">{formatDate(row.lastWorkingDay)}</span>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <DataBar
          label="Clearance"
          labelClassName="w-20 text-neutral-500"
          pct={pct}
          value={`${row.completedTasks}/${row.totalTasks}`}
        />
      </div>
    </a>
  );
}
