"use client";

import { useMemo } from "react";
import { Card, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { PanelInterviewRow } from "@hireops/api-types";
import { InterviewCard } from "./InterviewCard";

/**
 * INT-03 / PANEL-01 — "My interviews". The interviews the signed-in panellist is
 * on, split into Upcoming and Past, rendered as the shared InterviewCard so this
 * surface reads consistently with the PANEL-01 dashboard.
 */

function inWindowNow(iv: PanelInterviewRow): boolean {
  if (iv.status !== "scheduled" || !iv.scheduledStart || !iv.scheduledEnd) return false;
  const now = Date.now();
  return new Date(iv.scheduledStart).getTime() <= now && new Date(iv.scheduledEnd).getTime() >= now;
}

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
    up.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    pastRows.sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));
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
        <Card>
          <p className="text-sm text-neutral-400">{emptyHint}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((iv) => (
            <InterviewCard key={iv.id} interview={iv} inWindowNow={inWindowNow(iv)} />
          ))}
        </div>
      )}
    </section>
  );
}
