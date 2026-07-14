"use client";

import { useState } from "react";
import {
  onboardingCaseStatusSchema,
  type ListOnboardingCasesOutput,
  type OnboardingCaseListRow,
  type OnboardingCaseStatus,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Badge, DataBar, EmptyState } from "@/components/ui";
import { CASE_STATUS_META, formatDate, formatGeography } from "./onboarding-format";

/**
 * The onboarding case list — one row per accepted hire, filterable by case
 * status. Seeded from the server render (`initial`, the unfiltered first
 * page) and kept live by a React Query fetch keyed on the status filter so
 * the screen reflects task progress made in the detail view when a recruiter
 * navigates back.
 *
 * A case only exists once a candidate accepts their offer, so a fresh demo
 * DB lands here empty — the empty state explains how a case comes to be
 * rather than just saying "nothing here".
 *
 * Rows deep-link to /onboarding/[caseId]; no drawer — the detail is a real
 * routed page so a recruiter can share the link.
 */

const STATUS_OPTIONS = onboardingCaseStatusSchema.options as readonly OnboardingCaseStatus[];

export function OnboardingList({ initial }: { initial: ListOnboardingCasesOutput }) {
  const [status, setStatus] = useState<OnboardingCaseStatus | undefined>(undefined);

  const query = trpc.listOnboardingCases.useQuery(
    { status, limit: 100 },
    {
      // Seed only the unfiltered view from the server render; a filtered
      // view fetches fresh. keepPreviousData avoids an empty flash on
      // filter change.
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
      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Filter
        </span>
        <label className="flex items-center gap-1 text-sm">
          <span className="sr-only">Case status</span>
          <select
            aria-label="Filter by case status"
            value={status ?? ""}
            onChange={(e) =>
              setStatus((e.target.value || undefined) as OnboardingCaseStatus | undefined)
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
            className="ml-auto rounded-md px-2 py-1 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
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
              hint="Nothing matches this status right now. Clear the filter to see every onboarding case."
            />
          ) : (
            <EmptyState
              className="py-14"
              title="No onboarding cases yet"
              hint="An onboarding case opens itself the moment a candidate accepts their offer — with a pre-boarding checklist ready to go. Extend and land an offer from Triage, and every accepted hire will show up here to be onboarded."
            />
          )}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((row) => (
            <li key={row.id}>
              <OnboardingRow row={row} />
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

function OnboardingRow({ row }: { row: OnboardingCaseListRow }) {
  const meta = CASE_STATUS_META[row.status];
  const pct = row.totalTasks > 0 ? (row.completedTasks / row.totalTasks) * 100 : 0;

  return (
    <a
      href={`/onboarding/${row.id}`}
      className="block rounded-md border border-neutral-200 bg-white px-5 py-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-neutral-900">
              {row.candidateName ?? "Candidate"}
            </p>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-sm text-neutral-600">
            {row.positionTitle ?? "Requisition"}
          </p>
        </div>
        <div className="shrink-0 text-right text-xs text-neutral-500">
          <div>{formatGeography(row.geographyCode)}</div>
          <div className="mt-0.5">
            Starts <span className="text-neutral-700">{formatDate(row.expectedStartDate)}</span>
          </div>
        </div>
      </div>
      <div className="mt-3">
        <DataBar
          label="Checklist"
          labelClassName="w-20 text-neutral-500"
          pct={pct}
          value={`${row.completedTasks}/${row.totalTasks}`}
        />
      </div>
    </a>
  );
}
