"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Input, Select } from "@hireops/ui";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { InterviewDecisionControls } from "./InterviewDecisionControls";

/**
 * Interview scheduling inside the CandidateDetailDrawer (INT-02). Mirrors
 * OfferSection: shows the rounds already scheduled for this application, and a
 * "Schedule interview" form that picks a plan round + date/time + panel and
 * calls scheduleInterview (which mints the candidate confirm link + invitation
 * email). Reschedule / cancel act on an existing round.
 */

interface Props {
  applicationId: string;
}

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function InterviewScheduleSection({ applicationId }: Props) {
  const queryClient = useQueryClient();
  const plan = trpc.getInterviewPlan.useQuery({ applicationId });
  const list = trpc.listInterviewsByApplication.useQuery({ applicationId });
  const members = trpc.listTenantMemberships.useQuery(undefined);
  const [showForm, setShowForm] = useState(false);
  const [rescheduleRound, setRescheduleRound] = useState<number | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [["listInterviewsByApplication"]] });
    void queryClient.invalidateQueries({ queryKey: [["listUpcomingInterviews"]] });
  };

  const cancel = trpc.cancelInterview.useMutation({ onSuccess: invalidate });

  const rows = list.data?.rows ?? [];
  const activeRounds = new Set(
    rows.filter((r) => r.status !== "cancelled").map((r) => r.roundNumber),
  );
  const planRounds = plan.data?.rounds ?? [];

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Interviews
        </h3>
        {planRounds.length > 0 && !showForm && rescheduleRound === null ? (
          <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
            Schedule interview
          </Button>
        ) : null}
      </header>

      {planRounds.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No interview plan on this requisition yet. Define rounds on the requisition first.
        </p>
      ) : null}

      {showForm ? (
        <ScheduleForm
          applicationId={applicationId}
          planRounds={planRounds}
          disabledRounds={activeRounds}
          members={members.data?.items ?? []}
          mode="schedule"
          onDone={() => {
            setShowForm(false);
            invalidate();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {rescheduleRound !== null ? (
        <ScheduleForm
          applicationId={applicationId}
          planRounds={planRounds}
          disabledRounds={new Set()}
          forcedRound={rescheduleRound}
          members={members.data?.items ?? []}
          mode="reschedule"
          onDone={() => {
            setRescheduleRound(null);
            invalidate();
          }}
          onCancel={() => setRescheduleRound(null)}
        />
      ) : null}

      <ul className="mt-3 space-y-3">
        {rows.map((iv) => (
          <li key={iv.id} className="rounded-md border border-neutral-200 p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-neutral-900">
                Round {iv.roundNumber} · {iv.roundName}
              </span>
              <Badge tone={statusTone(iv.status)}>{iv.status}</Badge>
            </div>
            <p className="text-xs text-neutral-600">
              {formatWhen(iv.scheduledStart)} · {MODE_LABEL[iv.mode] ?? iv.mode} ·{" "}
              {iv.durationMinutes}m
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Panel: {iv.panel.map((p) => p.name ?? "member").join(", ") || "—"}
            </p>
            <div className="mt-1">
              {iv.candidateConfirmedAt ? (
                <Badge tone="success">Candidate confirmed</Badge>
              ) : iv.status === "scheduled" ? (
                <Badge tone="warning">Awaiting confirmation</Badge>
              ) : null}
            </div>
            {iv.status === "scheduled" ? (
              <div className="mt-2 flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setShowForm(false);
                    setRescheduleRound(iv.roundNumber);
                  }}
                >
                  Reschedule
                </Button>
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
            ) : null}
            {iv.status === "scheduled" || iv.status === "completed" ? (
              <InterviewDecisionControls interview={iv} onChanged={invalidate} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface PlanRound {
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  mode: string;
  defaultPanelMembershipIds: string[];
}
interface Membership {
  membershipId: string;
  displayName: string | null;
  email: string | null;
}

function ScheduleForm({
  applicationId,
  planRounds,
  disabledRounds,
  forcedRound,
  members,
  mode,
  onDone,
  onCancel,
}: {
  applicationId: string;
  planRounds: PlanRound[];
  disabledRounds: Set<number>;
  forcedRound?: number;
  members: Membership[];
  mode: "schedule" | "reschedule";
  onDone: () => void;
  onCancel: () => void;
}) {
  const schedule = trpc.scheduleInterview.useMutation({ onSuccess: onDone });
  const reschedule = trpc.rescheduleInterview.useMutation({ onSuccess: onDone });

  const firstSelectable =
    forcedRound ??
    planRounds.find((r) => !disabledRounds.has(r.roundNumber))?.roundNumber ??
    planRounds[0]?.roundNumber ??
    1;
  const [roundNumber, setRoundNumber] = useState<number>(firstSelectable);
  const selectedRound = planRounds.find((r) => r.roundNumber === roundNumber);
  const [start, setStart] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [panel, setPanel] = useState<string[]>(selectedRound?.defaultPanelMembershipIds ?? []);
  const [lead, setLead] = useState<string>("");

  const memberLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of members)
      m.set(x.membershipId, x.displayName ?? x.email ?? x.membershipId.slice(0, 8));
    return m;
  }, [members]);

  const roundOptions = planRounds.map((r) => ({
    value: String(r.roundNumber),
    label: `Round ${r.roundNumber} — ${r.roundName}`,
    disabled: forcedRound === undefined && disabledRounds.has(r.roundNumber),
  }));

  function onRoundChange(v: string) {
    const n = parseInt(v, 10);
    setRoundNumber(n);
    const pr = planRounds.find((r) => r.roundNumber === n);
    setPanel(pr?.defaultPanelMembershipIds ?? []);
  }
  function togglePanel(id: string) {
    setPanel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    if (lead && !panel.includes(lead)) setLead("");
  }

  const canSubmit = start.length > 0 && panel.length >= 1;
  const busy = schedule.isPending || reschedule.isPending;
  const err = schedule.error?.message ?? reschedule.error?.message ?? null;

  function submit() {
    if (!canSubmit) return;
    const payload = {
      applicationId,
      roundNumber,
      scheduledStart: new Date(start).toISOString(),
      panelMembershipIds: panel,
      leadMembershipId: lead && panel.includes(lead) ? lead : undefined,
      meetingUrl: meetingUrl.trim() || undefined,
    };
    if (mode === "reschedule") reschedule.mutate(payload);
    else schedule.mutate(payload);
  }

  return (
    <form
      className="space-y-3 rounded-md border border-brand-200 bg-brand-50/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
        {mode === "reschedule" ? "Reschedule round" : "Schedule a round"}
      </p>
      <Select
        label="Round"
        options={roundOptions}
        value={String(roundNumber)}
        disabled={forcedRound !== undefined}
        onValueChange={onRoundChange}
      />
      <Input
        type="datetime-local"
        label="Date & time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        required
      />
      <label className="block">
        <span className="text-sm font-medium text-neutral-700">Meeting URL (optional)</span>
        <input
          type="url"
          value={meetingUrl}
          onChange={(e) => setMeetingUrl(e.target.value)}
          placeholder="https://meet.example.com/…"
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
        />
      </label>
      <div>
        <p className="mb-1 text-sm font-medium text-neutral-700">
          Panel <span className="text-neutral-400">(at least one)</span>
        </p>
        {members.length === 0 ? (
          <p className="text-xs text-neutral-500">No memberships available.</p>
        ) : (
          <div className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-neutral-200 bg-white p-2">
            {members.map((m) => (
              <label
                key={m.membershipId}
                className="flex items-center gap-2 text-sm text-neutral-700"
              >
                <input
                  type="checkbox"
                  checked={panel.includes(m.membershipId)}
                  onChange={() => togglePanel(m.membershipId)}
                />
                {memberLabel.get(m.membershipId)}
              </label>
            ))}
          </div>
        )}
      </div>
      {panel.length > 0 ? (
        <Select
          label="Lead (optional)"
          placeholder="No lead"
          options={panel.map((id) => ({ value: id, label: memberLabel.get(id) ?? id }))}
          value={lead}
          onValueChange={setLead}
        />
      ) : null}
      {err ? <p className="text-xs text-status-error-700">{err}</p> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={!canSubmit || busy}>
          {busy ? "Saving…" : mode === "reschedule" ? "Reschedule" : "Schedule"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
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
  if (!iso) return "Time TBC";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
