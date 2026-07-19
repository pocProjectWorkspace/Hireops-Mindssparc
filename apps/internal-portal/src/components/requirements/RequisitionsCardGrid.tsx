"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import type { ListMyRequisitionsV2Output, RequisitionSkillChip } from "@hireops/api-types";
import { ReqStatusChip, DifficultyChip } from "./shared";

/**
 * RequisitionsCardGrid (RECR-01) — the recruiter card-grid view of the
 * requisition library, matching the prototype's gestalt on OUR tokens. Pure
 * presentation over the SAME listMyRequisitionsV2 rows the RO table reads;
 * requisition logic is untouched. Status + difficulty chips, weighted-skill
 * chips, live candidate count, interview rounds, and INR salary (never USD —
 * the server formats the band with Indian grouping). Cards link to the detail.
 */

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "posted", label: "Live" },
  { value: "on_hold", label: "On hold" },
  { value: "filled", label: "Filled" },
  { value: "cancelled", label: "Rejected" },
  { value: "closed", label: "Closed" },
];

function SkillChip({ skill }: { skill: RequisitionSkillChip }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        skill.required ? "bg-brand-50 text-brand-700" : "bg-neutral-100 text-neutral-600",
      )}
      title={skill.required ? "Must-have skill" : "Weighted skill"}
    >
      {skill.name}
      <span className="tabular-nums opacity-70">({skill.weight})</span>
    </span>
  );
}

function CandidatesIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="text-neutral-400"
    >
      <path
        d="M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M22 20v-1a4 4 0 0 0-3-3.87M16 4.13a4 4 0 0 1 0 7.75M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RoundsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="text-neutral-400"
    >
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z M14 2v6h6M9 13h6M9 17h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RupeeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="text-neutral-400"
    >
      <path
        d="M6 3h12M6 8h12M6 13l8.5 8M6 8a5 5 0 0 1 5 5H6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RequisitionsCardGrid({ initial }: { initial: ListMyRequisitionsV2Output }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return initial.rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (!q) return true;
      return (
        (r.title ?? "").toLowerCase().includes(q) ||
        (r.department ?? "").toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      );
    });
  }, [initial.rows, search, status]);

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search role, department, or ID…"
          className="h-9 w-full max-w-xs rounded-md border border-neutral-300 px-3 text-sm text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-neutral-400">
          {filtered.length} requisition{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={initial.rows.length === 0 ? "No requisitions yet" : "No matches"}
            hint={
              initial.rows.length === 0
                ? "Approved and draft requisitions appear here."
                : "Try a different search or status filter."
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map((r) => (
            <a
              key={r.id}
              href={`/requisitions/${r.id}`}
              className="flex flex-col gap-3 rounded-card border border-neutral-200 bg-white p-5 transition-colors hover:border-neutral-300 hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-neutral-900">
                    {r.title ?? "Untitled role"}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">
                    {[r.department ?? null, `REQ-${r.id.slice(0, 6)}`].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <ReqStatusChip status={r.status} />
                  <DifficultyChip difficulty={r.difficulty} />
                </div>
              </div>

              {r.skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {r.skills.map((s) => (
                    <SkillChip key={s.name} skill={s} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-neutral-400">No weighted skills defined yet.</p>
              )}

              <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-neutral-600">
                <span className="inline-flex items-center gap-1.5">
                  <CandidatesIcon />
                  {r.candidateCount} candidate{r.candidateCount === 1 ? "" : "s"}
                </span>
                {r.salaryInr ? (
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <RupeeIcon />
                    {r.salaryInr}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1.5">
                  <RoundsIcon />
                  {r.interviewRounds} round{r.interviewRounds === 1 ? "" : "s"}
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
