"use client";

import { useEffect, useState } from "react";
import type { SkillWeightingReq } from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button, Card, Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { SkillWeightsEditor, newSkillRow, type SkillWeightRow } from "./SkillWeightsEditor";

/**
 * RO-02 — the /skill-weighting workspace. A pick-a-requisition list (skill
 * coverage summary) on the left; picking one loads its detail and mounts the
 * SkillWeightsEditor. Saving replace-sets the skills via the REQ-02
 * updateRequisitionDraft mutation (draft-only — the same server rule the wizard
 * relies on). Non-draft reqs render read-only.
 */

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "success",
  posted: "info",
  filled: "success",
  cancelled: "error",
  closed: "neutral",
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SkillWeightingWorkspace({ rows }: { rows: SkillWeightingReq[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-neutral-600">
          No requisitions yet. Create one from Requisitions → New requisition, then weight its
          skills here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {!selected ? (
        <>
          <p className="text-sm text-neutral-600">
            Pick a requisition to review or tune its skill weights.
          </p>
          <div className="space-y-2">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className="flex w-full items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/30"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-900">
                    {r.title ?? "Untitled role"}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">{r.department ?? "—"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
                  <span>
                    {r.skillCount} skill{r.skillCount === 1 ? "" : "s"} · {r.mustHaveCount}{" "}
                    must-have
                  </span>
                  <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{statusLabel(r.status)}</Badge>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <SelectedReqEditor req={selected} onBack={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function SelectedReqEditor({ req, onBack }: { req: SkillWeightingReq; onBack: () => void }) {
  const detail = trpc.getRequisitionDetail.useQuery({ requisitionId: req.id });
  const update = trpc.updateRequisitionDraft.useMutation();
  const [skills, setSkills] = useState<SkillWeightRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the editable rows once the detail loads.
  useEffect(() => {
    if (!detail.data || skills !== null) return;
    setSkills(
      detail.data.skills.map((s) =>
        newSkillRow({
          skillName: s.skillName,
          category: s.category ?? "General",
          weight: Math.round(s.weight),
          isRequired: s.isRequired,
          minYears: s.minYears ?? null,
          notes: s.notes ?? "",
        }),
      ),
    );
  }, [detail.data, skills]);

  const editable = req.editable;

  async function onSave() {
    if (!skills) return;
    setError(null);
    setNotice(null);
    try {
      const res = await update.mutateAsync({
        requisitionId: req.id,
        skills: skills
          .filter((s) => s.skillName.trim().length > 0)
          .map((s) => ({
            skillName: s.skillName.trim(),
            weight: s.weight,
            isRequired: s.isRequired,
            category: s.category.trim() || null,
            minYears: s.minYears,
            notes: s.notes.trim() || null,
          })),
      });
      setNotice(`Saved ${res.skillCount} skill${res.skillCount === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the weights.");
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  return (
    <Card padded={false} className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <button className="text-xs text-brand-600 hover:underline" onClick={onBack}>
            ← All requisitions
          </button>
          <h2 className="mt-1 text-base font-semibold text-neutral-900">
            {req.title ?? "Untitled role"}
          </h2>
        </div>
        <Badge tone={STATUS_TONE[req.status] ?? "neutral"}>{statusLabel(req.status)}</Badge>
      </div>

      {!editable ? (
        <div className="mb-4 rounded-lg border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-700">
          This requisition is {statusLabel(req.status).toLowerCase()} — its skill weights are
          locked. Weights can only be edited while a requisition is a draft.
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {detail.isLoading || skills === null ? (
        <p className="text-sm text-neutral-500">Loading skills…</p>
      ) : editable ? (
        <>
          <SkillWeightsEditor skills={skills} onChange={setSkills} />
          <div className="mt-6 flex justify-end">
            <Button onClick={onSave} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save weights"}
            </Button>
          </div>
        </>
      ) : (
        <ReadOnlySkills skills={skills} />
      )}
    </Card>
  );
}

function ReadOnlySkills({ skills }: { skills: SkillWeightRow[] }) {
  if (skills.length === 0) {
    return <p className="text-sm text-neutral-500">No skills defined.</p>;
  }
  return (
    <ul className="space-y-2">
      {skills.map((s) => (
        <li
          key={s.key}
          className="flex items-center justify-between rounded-lg border border-neutral-200 p-3 text-sm"
        >
          <span className="text-neutral-900">
            {s.skillName}
            {s.category ? (
              <span className="ml-2 text-xs text-neutral-500">{s.category}</span>
            ) : null}
          </span>
          <span className="text-xs text-neutral-600">
            weight {s.weight}
            {s.isRequired ? " · must-have" : ""}
            {s.minYears != null ? ` · ${s.minYears}y min` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
