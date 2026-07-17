"use client";

import { useMemo } from "react";
import { Badge, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { FeedbackState, PanelInterviewRow } from "@hireops/api-types";

/**
 * INT-03 — "My interviews" list. The interviews the signed-in panellist is on,
 * split into Upcoming (scheduled) and Past, each row badged with the
 * panellist's own feedback state (none/draft/submitted) and linking to the
 * brief + scorecard at /panel/[interviewId].
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function PanelInterviewsListView() {
  const list = trpc.listMyPanelInterviews.useQuery({}, { placeholderData: (prev) => prev });
  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const up: PanelInterviewRow[] = [];
    const pastRows: PanelInterviewRow[] = [];
    for (const r of rows) {
      const isPast =
        r.status === "completed" ||
        r.status === "no_show" ||
        (r.scheduledStart !== null && new Date(r.scheduledStart).getTime() < now);
      if (r.status === "cancelled" || isPast) pastRows.push(r);
      else up.push(r);
    }
    return { upcoming: up, past: pastRows };
  }, [rows]);

  if (list.isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-sm text-neutral-500">Loading…</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <EmptyState
          title="No interviews assigned"
          hint="When a recruiter puts you on an interview panel, it appears here with a link to the candidate brief and your scorecard."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <PanelSection title="Upcoming" rows={upcoming} emptyHint="No upcoming interviews." />
      <div className="h-8" />
      <PanelSection title="Past" rows={past} emptyHint="No past interviews yet." />
    </div>
  );
}

function PanelSection({
  title,
  rows,
  emptyHint,
}: {
  title: string;
  rows: PanelInterviewRow[];
  emptyHint: string;
}) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {title}
        <span className="ml-2 font-normal text-neutral-400">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-400">{emptyHint}</p>
      ) : (
        <TableShell>
          <Thead>
            <Tr>
              <Th>Candidate</Th>
              <Th>Role</Th>
              <Th>Round</Th>
              <Th>When</Th>
              <Th>Status</Th>
              <Th>My scorecard</Th>
              <Th> </Th>
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
                <Td>
                  <Badge tone={statusTone(iv.status)}>{iv.status.replace(/_/g, " ")}</Badge>
                </Td>
                <Td>
                  <Badge tone={feedbackTone(iv.myFeedbackState)}>
                    {feedbackLabel(iv.myFeedbackState)}
                  </Badge>
                </Td>
                <Td>
                  <a
                    href={`/panel/${iv.id}`}
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    Open brief
                  </a>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </section>
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

function feedbackTone(state: FeedbackState): BadgeTone {
  switch (state) {
    case "submitted":
      return "success";
    case "draft":
      return "warning";
    default:
      return "neutral";
  }
}

function feedbackLabel(state: FeedbackState): string {
  switch (state) {
    case "submitted":
      return "Submitted";
    case "draft":
      return "Draft saved";
    default:
      return "Not started";
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "TBC";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
