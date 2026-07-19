"use client";

import { useState } from "react";
import type {
  ListApplicationDocumentCandidatesOutput,
  ApplicationDocumentCandidateRow,
  ApplicationDocumentStatus,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { EmptyState } from "@/components/ui";
import { HeroStatCard, DocStatusChip, DocOverallChip, PageHeader } from "@/components/patterns";
import { StatTile } from "@/components/ui";
import { ApplicationDocumentsPanel } from "./ApplicationDocumentsPanel";

/**
 * /hr-documents (HROPS-03) — the hr_ops Documents & verification surface.
 * Hero stats + search + status filter + one expandable row per candidate in
 * the pre-offer window (tech_interview → offer_accepted) with per-doc status
 * chips, an overall rollup, and the request/verify/reject actions via the
 * reusable ApplicationDocumentsPanel.
 */

const STATUS_OPTIONS: { value: ApplicationDocumentStatus; label: string }[] = [
  { value: "requested", label: "Pending" },
  { value: "uploaded", label: "Uploaded" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
];

const STAGE_LABEL: Record<string, string> = {
  tech_interview: "Tech interview",
  hr_round: "HR round",
  offer_drafted: "Offer drafted",
  offer_accepted: "Offer accepted",
};

export function HrDocumentsView({ initial }: { initial: ListApplicationDocumentCandidatesOutput }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ApplicationDocumentStatus | undefined>(undefined);
  const utils = trpc.useUtils();

  const query = trpc.listApplicationDocumentCandidates.useQuery(
    { search: search || undefined, status, limit: 100 },
    {
      initialData: !search && !status ? initial : undefined,
      placeholderData: (prev) => prev,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  );

  const items = query.data?.items ?? [];
  const stats = query.data?.stats ?? initial.stats;
  const invalidate = () => void utils.listApplicationDocumentCandidates.invalidate();

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <PageHeader
        title="Documents & verification"
        subtitle="Pre-offer document collection for candidates between technical interview and offer acceptance. Every document access is PII-logged."
        className="mb-5"
      />

      {/* Hero stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <HeroStatCard label="Candidates" value={stats.candidates} caption="with requested docs" />
        <StatTile label="Verified docs" value={stats.verifiedDocs} tone="positive" />
        <StatTile label="Pending docs" value={stats.pendingDocs} tone="warning" />
        <StatTile label="Total docs" value={stats.totalDocs} />
      </div>

      {/* Search + status filter */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate or role…"
          aria-label="Search candidates"
          className="w-64 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <select
          aria-label="Filter by document status"
          value={status ?? ""}
          onChange={(e) =>
            setStatus((e.target.value || undefined) as ApplicationDocumentStatus | undefined)
          }
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 transition-colors hover:border-neutral-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs tabular-nums text-neutral-400">
          {items.length} candidate{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-neutral-200 bg-white">
          <EmptyState
            className="py-14"
            title="No document requests yet"
            hint="Documents appear here once you request them from a candidate in the pre-offer window. Candidates in stages Tech interview through Offer accepted are eligible — request document types and they upload from their candidate portal."
          />
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map((row) => (
            <li key={row.applicationId}>
              <CandidateDocRow row={row} onChanged={invalidate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateDocRow({
  row,
  onChanged,
}: {
  row: ApplicationDocumentCandidateRow;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <p className="truncate text-sm font-semibold text-neutral-900">
              {row.candidateName ?? "Candidate"}
            </p>
            <span className="truncate text-sm text-neutral-500">{row.roleTitle ?? ""}</span>
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
              {STAGE_LABEL[row.stage] ?? row.stage}
            </span>
          </div>
          <DocOverallChip overall={row.overall} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.documents.map((d) => (
            <DocStatusChip key={d.id} status={d.status} name={d.documentTypeName} />
          ))}
        </div>
      </button>
      {open ? (
        <div className="border-t border-neutral-100 px-5 py-4">
          <ApplicationDocumentsPanel
            applicationId={row.applicationId}
            documents={row.documents}
            onChanged={onChanged}
          />
        </div>
      ) : null}
    </div>
  );
}
