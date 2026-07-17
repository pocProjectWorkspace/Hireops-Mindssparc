"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { Badge, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { InterviewStatus } from "@hireops/api-types";

/**
 * INT-02 — recruiter interviews list. Status-filterable, with reschedule
 * (routes to the candidate drawer where the schedule form lives) and cancel.
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };
const FILTERS: { value: InterviewStatus | "all"; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

export function InterviewsListView() {
  const [filter, setFilter] = useState<InterviewStatus | "all">("scheduled");
  const queryClient = useQueryClient();
  const list = trpc.listUpcomingInterviews.useQuery(filter === "all" ? {} : { status: filter }, {
    placeholderData: (prev) => prev,
  });
  const cancel = trpc.cancelInterview.useMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [["listUpcomingInterviews"]] });
    },
  });

  const rows = list.data?.rows ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={
              filter === f.value
                ? "rounded-full bg-brand-600 px-3 py-1 text-sm font-medium text-white"
                : "rounded-full border border-neutral-300 px-3 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No interviews"
          hint="Scheduled interviews appear here. Schedule one from a candidate in Triage."
        />
      ) : (
        <TableShell>
          <Thead>
            <Tr>
              <Th>Candidate</Th>
              <Th>Role</Th>
              <Th>Round</Th>
              <Th>When</Th>
              <Th>Panel</Th>
              <Th>Status</Th>
              <Th>Confirmed</Th>
              <Th>Actions</Th>
            </Tr>
          </Thead>
          <Tbody>
            {rows.map((iv) => (
              <Tr key={iv.id}>
                <Td>{iv.candidateName ?? "—"}</Td>
                <Td>{iv.positionTitle}</Td>
                <Td>
                  {iv.roundNumber}. {iv.roundName}
                  <span className="ml-1 text-xs text-neutral-400">
                    ({MODE_LABEL[iv.mode] ?? iv.mode})
                  </span>
                </Td>
                <Td>{formatWhen(iv.scheduledStart)}</Td>
                <Td className="max-w-[14rem] truncate">
                  {iv.panel.map((p) => p.name ?? "member").join(", ") || "—"}
                </Td>
                <Td>
                  <Badge tone={statusTone(iv.status)}>{iv.status}</Badge>
                </Td>
                <Td>
                  {iv.candidateConfirmedAt ? (
                    <Badge tone="success">Confirmed</Badge>
                  ) : iv.status === "scheduled" ? (
                    <Badge tone="warning">Pending</Badge>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </Td>
                <Td>
                  {iv.status === "scheduled" ? (
                    <div className="flex gap-2">
                      <a
                        href={`/triage?candidateId=${iv.candidateId}&applicationId=${iv.applicationId}`}
                        className="text-sm text-brand-700 hover:underline"
                      >
                        Manage
                      </a>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={cancel.isPending}
                        onClick={() => {
                          const reason = window.prompt("Cancel reason?", "No longer needed") ?? "";
                          if (reason) cancel.mutate({ interviewId: iv.id, reason });
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <span className="text-neutral-400">—</span>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      {list.data?.nextCursor ? (
        <p className="mt-3 text-xs text-neutral-500">
          More interviews exist — refine by status to narrow the list.
        </p>
      ) : null}
    </div>
  );
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "scheduled":
      return "info";
    case "completed":
      return "success";
    case "no_show":
    case "cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "TBC";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
