"use client";

import { useMemo, useState } from "react";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { PanelInterviewRow } from "@hireops/api-types";

/**
 * PANEL-02 — the session board ("All interviews"): the panellist's honest
 * subset of the monitor. My interviews as a board of cards, filterable by
 * Upcoming / Past / All + search, with an "in window now" accent for interviews
 * whose scheduled window contains the current time.
 *
 * DELIBERATELY NOT built (and no placeholder tiles for them): video embeds,
 * presence tracking, transcripts, sentiment/emotion inference. This is a
 * scheduling/context board, not a surveillance surface.
 *
 * Reads listMyPanelInterviews (the same query the "My interviews" list uses) —
 * no new procedure. If PANEL-01 lands a shared InterviewCard in the main tree,
 * this row markup is the reconciliation opportunity (see merge notes).
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

type FilterKey = "upcoming" | "past" | "all";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "all", label: "All" },
];

export function SessionBoard() {
  const list = trpc.listMyPanelInterviews.useQuery({}, { placeholderData: (prev) => prev });
  const [filter, setFilter] = useState<FilterKey>("upcoming");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const isPast =
        r.status === "completed" ||
        r.status === "no_show" ||
        r.status === "cancelled" ||
        (r.scheduledStart !== null && new Date(r.scheduledStart).getTime() < now);
      if (filter === "upcoming" && isPast) return false;
      if (filter === "past" && !isPast) return false;
      if (q) {
        const hay = `${r.candidateName ?? ""} ${r.positionTitle} ${r.roundName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  if (list.isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <p className="text-sm text-neutral-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={
                filter === f.key
                  ? "rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
                  : "rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search candidate, role or round"
          className="w-64 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No interviews to show"
          hint={
            rows.length === 0
              ? "When a recruiter puts you on an interview panel, it appears here."
              : "No interviews match this filter or search."
          }
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((iv) => (
            <BoardRow key={iv.id} iv={iv} />
          ))}
        </div>
      )}
    </div>
  );
}

function BoardRow({ iv }: { iv: PanelInterviewRow }) {
  const inWindow = isInWindowNow(iv.scheduledStart, iv.scheduledEnd);
  const others = iv.panel;
  return (
    <Card
      className={
        inWindow
          ? "border-l-4 border-l-brand-500 ring-1 ring-brand-100"
          : "border-l-4 border-l-transparent"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">
              {iv.candidateName ?? "Candidate"}
            </h3>
            <Badge tone={statusTone(iv.status)}>{iv.status.replace(/_/g, " ")}</Badge>
            {iv.candidateConfirmedAt && iv.status === "scheduled" ? (
              <Badge tone="success">Confirmed</Badge>
            ) : null}
            {inWindow ? (
              <span className="inline-flex items-center rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                In window now
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-neutral-600">{iv.positionTitle}</p>
          <p className="text-sm text-neutral-500">
            Round {iv.roundNumber}: {iv.roundName} ·{" "}
            {formatWindow(iv.scheduledStart, iv.scheduledEnd)} · {MODE_LABEL[iv.mode] ?? iv.mode} ·{" "}
            {iv.durationMinutes}m
          </p>
          {others.length > 0 ? (
            <p className="mt-1 text-xs text-neutral-400">
              Panel:{" "}
              {others.map((p) => `${p.name ?? "Panellist"}${p.isLead ? " (lead)" : ""}`).join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge tone={feedbackTone(iv.myFeedbackState)}>{feedbackLabel(iv.myFeedbackState)}</Badge>
          <div className="flex items-center gap-3 text-sm">
            <a href={`/panel/${iv.id}`} className="font-medium text-brand-700 hover:underline">
              Brief
            </a>
            {iv.meetingUrl ? (
              <a
                href={iv.meetingUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand-700 hover:underline"
              >
                Join
              </a>
            ) : null}
            <a href={`/panel/${iv.id}`} className="font-medium text-brand-700 hover:underline">
              Scorecard
            </a>
          </div>
        </div>
      </div>
    </Card>
  );
}

function isInWindowNow(start: string | null, end: string | null): boolean {
  if (!start) return false;
  const now = Date.now();
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : s + 60 * 60 * 1000;
  return now >= s && now <= e;
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

function feedbackTone(state: string): BadgeTone {
  switch (state) {
    case "submitted":
      return "success";
    case "draft":
      return "warning";
    default:
      return "neutral";
  }
}

function feedbackLabel(state: string): string {
  switch (state) {
    case "submitted":
      return "Scorecard submitted";
    case "draft":
      return "Scorecard draft";
    default:
      return "Scorecard not started";
  }
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start) return "Time TBC";
  const startStr = `${start.slice(0, 10)} ${start.slice(11, 16)}`;
  if (end && end.slice(0, 10) === start.slice(0, 10)) return `${startStr}–${end.slice(11, 16)}`;
  return startStr;
}
