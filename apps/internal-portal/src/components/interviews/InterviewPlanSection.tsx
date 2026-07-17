"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Input, Select } from "@hireops/ui";
import { Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Interview rounds editor on the requisition detail (INT-02). Defines the
 * plan (the blueprint): an ordered set of rounds with mode, scorecard
 * template, and an advisory default panel. Saving replace-sets the whole plan
 * (upsertInterviewPlan). Read-only for non-managers or a terminal requisition.
 */

type Mode = "video" | "onsite" | "phone";
type Scorecard = "technical" | "manager" | "hr" | "general";

interface EditableRound {
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  mode: Mode;
  scorecardTemplate: Scorecard;
  competencyFocus: string; // comma-separated in the editor
  defaultPanelMembershipIds: string[];
}

const MODE_OPTIONS = [
  { value: "video", label: "Video" },
  { value: "onsite", label: "On-site" },
  { value: "phone", label: "Phone" },
];
const SCORECARD_OPTIONS = [
  { value: "technical", label: "Technical" },
  { value: "manager", label: "Hiring manager" },
  { value: "hr", label: "HR" },
  { value: "general", label: "General" },
];

function toEditable(r: {
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  mode: string;
  scorecardTemplate: string;
  competencyFocus: string[];
  defaultPanelMembershipIds: string[];
}): EditableRound {
  return {
    roundNumber: r.roundNumber,
    roundName: r.roundName,
    durationMinutes: r.durationMinutes,
    mode: r.mode as Mode,
    scorecardTemplate: r.scorecardTemplate as Scorecard,
    competencyFocus: (r.competencyFocus ?? []).join(", "),
    defaultPanelMembershipIds: r.defaultPanelMembershipIds ?? [],
  };
}

export function InterviewPlanSection({
  requisitionId,
  canManage,
}: {
  requisitionId: string;
  canManage: boolean;
}) {
  const plan = trpc.getInterviewPlan.useQuery({ requisitionId });
  const members = trpc.listTenantMemberships.useQuery(undefined, { enabled: canManage });
  const upsert = trpc.upsertInterviewPlan.useMutation();

  const [rounds, setRounds] = useState<EditableRound[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan.data && rounds === null) {
      setRounds(plan.data.rounds.map(toEditable));
    }
  }, [plan.data, rounds]);

  const memberOptions = useMemo(
    () =>
      (members.data?.items ?? []).map((m) => ({
        id: m.membershipId,
        label: m.displayName ?? m.email ?? m.membershipId.slice(0, 8),
      })),
    [members.data],
  );

  if (plan.isLoading) {
    return (
      <Card>
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">Interview rounds</h3>
        <p className="text-sm text-neutral-500">Loading…</p>
      </Card>
    );
  }

  const editing = rounds ?? [];

  function update(idx: number, patch: Partial<EditableRound>) {
    setRounds((prev) => (prev ?? []).map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRound() {
    setRounds((prev) => {
      const list = prev ?? [];
      const next = list.length > 0 ? Math.max(...list.map((r) => r.roundNumber)) + 1 : 1;
      return [
        ...list,
        {
          roundNumber: next,
          roundName: `Round ${next}`,
          durationMinutes: 60,
          mode: "video",
          scorecardTemplate: "general",
          competencyFocus: "",
          defaultPanelMembershipIds: [],
        },
      ];
    });
  }
  function removeRound(idx: number) {
    setRounds((prev) => (prev ?? []).filter((_, i) => i !== idx));
  }
  function togglePanel(idx: number, membershipId: string) {
    setRounds((prev) =>
      (prev ?? []).map((r, i) => {
        if (i !== idx) return r;
        const has = r.defaultPanelMembershipIds.includes(membershipId);
        return {
          ...r,
          defaultPanelMembershipIds: has
            ? r.defaultPanelMembershipIds.filter((x) => x !== membershipId)
            : [...r.defaultPanelMembershipIds, membershipId],
        };
      }),
    );
  }

  async function onSave() {
    setError(null);
    setNotice(null);
    try {
      const res = await upsert.mutateAsync({
        requisitionId,
        rounds: editing.map((r) => ({
          roundNumber: r.roundNumber,
          roundName: r.roundName.trim() || `Round ${r.roundNumber}`,
          durationMinutes: r.durationMinutes,
          mode: r.mode,
          scorecardTemplate: r.scorecardTemplate,
          competencyFocus: r.competencyFocus
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          defaultPanelMembershipIds: r.defaultPanelMembershipIds,
        })),
      });
      setNotice(`Saved ${res.roundCount} round${res.roundCount === 1 ? "" : "s"}.`);
      await plan.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the plan.");
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">Interview rounds</h3>
        {canManage ? (
          <Button variant="secondary" size="sm" onClick={addRound}>
            Add round
          </Button>
        ) : null}
      </div>

      {notice ? (
        <div className="mb-3 rounded-lg border border-status-positive-200 bg-status-positive-50 px-3 py-2 text-sm text-status-positive-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-3 rounded-lg border border-status-error-200 bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {editing.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {canManage
            ? "No rounds defined yet. Add the interview loop for this role."
            : "No interview rounds defined."}
        </p>
      ) : (
        <ol className="space-y-4">
          {editing.map((r, idx) => (
            <li key={idx} className="rounded-lg border border-neutral-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Round {r.roundNumber}
                </span>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => removeRound(idx)}
                    className="text-xs text-status-error-600 hover:underline"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  label="Round name"
                  value={r.roundName}
                  disabled={!canManage}
                  onChange={(e) => update(idx, { roundName: e.target.value })}
                />
                <Input
                  type="number"
                  label="Duration (minutes)"
                  value={String(r.durationMinutes)}
                  disabled={!canManage}
                  onChange={(e) =>
                    update(idx, {
                      durationMinutes: Math.max(15, parseInt(e.target.value, 10) || 60),
                    })
                  }
                />
                <Select
                  label="Mode"
                  options={MODE_OPTIONS}
                  value={r.mode}
                  disabled={!canManage}
                  onValueChange={(v) => update(idx, { mode: v as Mode })}
                />
                <Select
                  label="Scorecard"
                  options={SCORECARD_OPTIONS}
                  value={r.scorecardTemplate}
                  disabled={!canManage}
                  onValueChange={(v) => update(idx, { scorecardTemplate: v as Scorecard })}
                />
              </div>
              <div className="mt-3">
                <Input
                  label="Competency focus (comma-separated)"
                  value={r.competencyFocus}
                  disabled={!canManage}
                  onChange={(e) => update(idx, { competencyFocus: e.target.value })}
                  placeholder="system_design, ownership"
                />
              </div>
              <div className="mt-3">
                <p className="mb-1 text-sm font-medium text-neutral-700">Default panel</p>
                {memberOptions.length === 0 ? (
                  <p className="text-xs text-neutral-500">No memberships available.</p>
                ) : (
                  <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-md border border-neutral-200 p-2">
                    {memberOptions.map((m) => (
                      <label
                        key={m.id}
                        className="flex items-center gap-1.5 text-sm text-neutral-700"
                      >
                        <input
                          type="checkbox"
                          checked={r.defaultPanelMembershipIds.includes(m.id)}
                          disabled={!canManage}
                          onChange={() => togglePanel(idx, m.id)}
                        />
                        {m.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {canManage ? (
        <div className="mt-4 flex items-center gap-2">
          <Button onClick={onSave} disabled={upsert.isPending}>
            {upsert.isPending ? "Saving…" : "Save plan"}
          </Button>
          <span className="text-xs text-neutral-500">Saving replaces the whole plan.</span>
        </div>
      ) : null}
    </Card>
  );
}
