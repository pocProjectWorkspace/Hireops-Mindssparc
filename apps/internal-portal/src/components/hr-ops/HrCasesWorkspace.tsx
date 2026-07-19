"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ListHrCasesOutput, HrCaseListRow, HrCaseStage } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { TableShell, Thead, Th, Tbody, Tr, Td, EmptyState, StatTile } from "@/components/ui";
import {
  PageHeader,
  HeroStatCard,
  RecommendationChip,
  StageChip,
  InboxIcon,
} from "@/components/patterns";

/**
 * HrCasesWorkspace (HROPS-01) — the HR Ops cases list surface.
 *
 * Hero-stat strip (Total / HR round pending / Offer stage / Accepted), a search
 * box + stage filter tabs, and the rich case table: candidate, role, stage chip,
 * AI score, per-round interview recommendations as inline chips, salary band,
 * assigned recruiter, last activity. A row opens the case detail. Stats come
 * from the server (whole window); filtering is client-side over the full set so
 * the surface stays snappy.
 */

type StageTab = "all" | HrCaseStage;

const STAGE_TABS: { key: StageTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "hr_round", label: "HR round" },
  { key: "tech_interview", label: "Tech interview" },
  { key: "offer_drafted", label: "Offer stage" },
  { key: "offer_accepted", label: "Accepted" },
];

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export function HrCasesWorkspace({ initial }: { initial: ListHrCasesOutput }) {
  const router = useRouter();
  const { data } = trpc.listHrCases.useQuery(
    {},
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );
  const [tab, setTab] = useState<StageTab>("all");
  const [search, setSearch] = useState("");

  const stats = data.stats;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (tab !== "all" && r.stage !== tab) return false;
      if (needle) {
        const hay = `${r.candidateName ?? ""} ${r.roleTitle ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [data.rows, tab, search]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-8 py-6">
      <PageHeader
        title="HR cases"
        subtitle="Candidates in the offer-desk window — technical rounds through to an accepted offer. Open a case to review interview feedback and run the HR round."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <HeroStatCard
          label="HR round pending"
          value={stats.hrRoundPending}
          caption="in HR round, no saved assessment"
          icon={<InboxIcon />}
        />
        <StatTile label="Total cases" value={stats.total} tone="neutral" />
        <StatTile label="Offer stage" value={stats.offerStage} tone="warning" />
        <StatTile label="Accepted" value={stats.accepted} tone="positive" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 border-b border-neutral-200">
          {STAGE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.key
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-neutral-500 hover:text-neutral-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate or role…"
          className="h-9 w-64 rounded-md border border-neutral-300 px-3 text-sm text-neutral-900 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-brand-500"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No HR cases"
          hint="When a candidate reaches the technical or HR round, they appear here for the HR Ops team to work through to an offer."
        />
      ) : (
        <TableShell>
          <Thead>
            <Th>Candidate</Th>
            <Th>Role</Th>
            <Th>Stage</Th>
            <Th numeric>AI score</Th>
            <Th>Interview rounds</Th>
            <Th>Salary band</Th>
            <Th>Recruiter</Th>
            <Th numeric>Last activity</Th>
            <Th className="w-8" aria-label="Open" />
          </Thead>
          <Tbody>
            {filtered.map((r) => (
              <HrCaseRow
                key={r.applicationId}
                row={r}
                onOpen={() => router.push(`/hr-cases/${r.applicationId}`)}
              />
            ))}
          </Tbody>
        </TableShell>
      )}
    </div>
  );
}

function HrCaseRow({ row, onOpen }: { row: HrCaseListRow; onOpen: () => void }) {
  return (
    <Tr onClick={onOpen} className="cursor-pointer">
      <Td className="font-medium text-neutral-900">{row.candidateName ?? "Unknown candidate"}</Td>
      <Td>{row.roleTitle ?? "—"}</Td>
      <Td>
        <StageChip stage={row.stage} />
      </Td>
      <Td numeric>
        {row.aiScore != null ? (
          <span className="font-semibold tabular-nums text-neutral-900">
            {Math.round(row.aiScore)}%
          </span>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </Td>
      <Td>
        {row.roundResults.length === 0 ? (
          <span className="text-neutral-400">No rounds</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.roundResults.map((rr) => (
              <RecommendationChip
                key={rr.interviewId}
                round={rr.roundNumber}
                recommendation={rr.recommendation}
              />
            ))}
          </div>
        )}
      </Td>
      <Td>{row.salaryBand ?? "—"}</Td>
      <Td>{row.assignedRecruiterName ?? "—"}</Td>
      <Td numeric className="text-neutral-500">
        {formatWhen(row.lastActivityAt)}
      </Td>
      <Td className="text-neutral-300" aria-hidden>
        →
      </Td>
    </Tr>
  );
}
