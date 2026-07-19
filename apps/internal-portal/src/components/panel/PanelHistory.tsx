"use client";

import { useMemo, useState } from "react";
import { Card, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import { RecommendationChip } from "@/components/patterns";
import { trpc } from "@/lib/trpc-client";
import type { GetPanelDashboardOutput, PanelSubmittedFeedbackItem } from "@hireops/api-types";

/**
 * PanelHistory (PANEL-01) — /panel/history.
 *
 * A table of MY completed + submitted interviews (from getPanelDashboard's
 * submitted list): candidate, role, round chip, date, my avg score (from my
 * scorecard jsonb), my RecommendationChip. Client search + a simple round
 * filter over the seeded list.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function PanelHistory({ initialBoard }: { initialBoard: GetPanelDashboardOutput }) {
  const query = trpc.getPanelDashboard.useQuery(undefined, { initialData: initialBoard });
  const submitted = useMemo(
    () => query.data?.submitted ?? initialBoard.submitted,
    [query.data, initialBoard.submitted],
  );

  const [search, setSearch] = useState("");
  const [round, setRound] = useState<string>("all");

  const rounds = useMemo(() => {
    const set = new Set<number>();
    for (const s of submitted) set.add(s.roundNumber);
    return [...set].sort((a, b) => a - b);
  }, [submitted]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return submitted.filter((s) => {
      if (round !== "all" && String(s.roundNumber) !== round) return false;
      if (!q) return true;
      return (
        (s.candidateName ?? "").toLowerCase().includes(q) ||
        s.roleTitle.toLowerCase().includes(q) ||
        s.roundName.toLowerCase().includes(q)
      );
    });
  }, [submitted, search, round]);

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate, role, or round…"
          className="h-9 w-full max-w-xs rounded-md border border-neutral-300 px-3 text-sm text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <select
          value={round}
          onChange={(e) => setRound(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="all">All rounds</option>
          {rounds.map((r) => (
            <option key={r} value={String(r)}>
              Round {r}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={submitted.length === 0 ? "No past interviews yet" : "No matches"}
            hint={
              submitted.length === 0
                ? "Once you submit a scorecard, the interview appears here."
                : "Try a different search or round filter."
            }
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Candidate</Th>
            <Th>Role</Th>
            <Th>Round</Th>
            <Th>Date</Th>
            <Th>My avg score</Th>
            <Th>My recommendation</Th>
          </Thead>
          <Tbody>
            {filtered.map((s: PanelSubmittedFeedbackItem) => (
              <Tr key={s.interviewId}>
                <Td>
                  <a
                    href={`/panel/${s.interviewId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {s.candidateName ?? "Candidate"}
                  </a>
                </Td>
                <Td>{s.roleTitle}</Td>
                <Td>
                  <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                    R{s.roundNumber}: {s.roundName}
                  </span>
                </Td>
                <Td>{fmtDate(s.submittedAt)}</Td>
                <Td>
                  <span className="tabular-nums text-neutral-800">
                    {s.avgScore === null ? "—" : s.avgScore.toFixed(1)}
                  </span>
                </Td>
                <Td>
                  <RecommendationChip recommendation={s.recommendation} />
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </div>
  );
}
