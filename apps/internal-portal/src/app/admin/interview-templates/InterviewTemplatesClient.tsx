"use client";

import { useMemo, useState } from "react";
import type {
  InterviewMode,
  InterviewRoundTemplateRow,
  ListInterviewRoundTemplatesOutput,
  ListScorecardTemplatesOutput,
  ScorecardTemplateCriterion,
} from "@hireops/api-types";
import { Button, Input, Select } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Interview templates editor (T2.2 / G07).
 *
 * TWO configs, one page:
 *  (A) Round loop — the tenant's DEFAULT ordered interview loop. A new
 *      requisition applies it (applyInterviewRoundTemplate seeds interview_plans);
 *      a tenant with no loop builds the plan from scratch as today.
 *  (B) Custom scorecards — rubrics beyond the 4 built-ins. A custom rubric's
 *      criteria are resolved + snapshot onto an interview at schedule time, so
 *      they genuinely drive the panel scorecard form.
 *
 * HONESTY — a round's scorecard must be a built-in OR a saved custom key (the
 * server rejects unknowns); a custom key can't redefine a built-in.
 */

const MODE_OPTIONS: { value: InterviewMode; label: string }[] = [
  { value: "video", label: "Video" },
  { value: "onsite", label: "Onsite" },
  { value: "phone", label: "Phone" },
];

type DraftRound = InterviewRoundTemplateRow & { competencyText: string };

function toDraftRound(r: InterviewRoundTemplateRow): DraftRound {
  return { ...r, competencyText: r.competencyFocus.join(", ") };
}

function emptyRound(roundNumber: number, scorecardKey: string): DraftRound {
  return {
    roundNumber,
    roundName: "",
    durationMinutes: 60,
    mode: "video",
    scorecardTemplateKey: scorecardKey,
    competencyFocus: [],
    competencyText: "",
  };
}

export function InterviewTemplatesClient({
  initialRounds,
  initialScorecards,
}: {
  initialRounds: ListInterviewRoundTemplatesOutput;
  initialScorecards: ListScorecardTemplatesOutput;
}) {
  const roundsQuery = trpc.listInterviewRoundTemplates.useQuery(undefined, {
    initialData: initialRounds,
  });
  const scorecardsQuery = trpc.listScorecardTemplates.useQuery(undefined, {
    initialData: initialScorecards,
  });

  const options = scorecardsQuery.data?.options ?? [];
  const custom = scorecardsQuery.data?.custom ?? [];
  const scorecardOptions = useMemo(
    () => options.map((o) => ({ value: o.scorecardKey, label: o.label })),
    [options],
  );
  const fallbackScorecardKey = options[0]?.scorecardKey ?? "general";

  const [rounds, setRounds] = useState<DraftRound[]>(
    (initialRounds.rounds ?? []).map(toDraftRound),
  );
  const [notice, setNotice] = useState<string | null>(null);

  // ── Round-loop mutations ──
  const upsertRounds = trpc.upsertInterviewRoundTemplate.useMutation({
    onSuccess: async (res) => {
      await roundsQuery.refetch();
      setRounds(res.rounds.map(toDraftRound));
      setNotice(
        `Saved the default loop (${res.roundCount} round${res.roundCount === 1 ? "" : "s"}).`,
      );
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });
  const clearRounds = trpc.deleteInterviewRoundTemplate.useMutation({
    onSuccess: async () => {
      await roundsQuery.refetch();
      setRounds([]);
      setNotice("Default loop cleared.");
    },
    onError: (err) => {
      setNotice(`Clear failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function updateRound(idx: number, patch: Partial<DraftRound>) {
    setRounds((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRound() {
    setRounds((rs) => [...rs, emptyRound(rs.length + 1, fallbackScorecardKey)]);
  }
  function removeRound(idx: number) {
    setRounds((rs) => rs.filter((_, i) => i !== idx).map((r, i) => ({ ...r, roundNumber: i + 1 })));
  }
  function saveRounds() {
    setNotice(null);
    upsertRounds.mutate({
      rounds: rounds.map((r) => ({
        roundNumber: r.roundNumber,
        roundName: r.roundName,
        durationMinutes: r.durationMinutes,
        mode: r.mode,
        scorecardTemplateKey: r.scorecardTemplateKey,
        competencyFocus: r.competencyText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      })),
    });
  }

  const roundsBusy = upsertRounds.isPending || clearRounds.isPending;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Interview templates"
        subtitle="Author the org's default interview loop (seeds a new requisition's plan) and any custom scorecard rubrics beyond the four built-ins."
      />

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.includes("failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        The <span className="font-medium">default loop</span> is genuinely consumed: a new
        requisition can apply it to seed its interview plan (a tenant with no loop builds the plan
        from scratch, exactly as before). A round&apos;s scorecard must be a built-in
        (technical/manager/hr/general) or a saved custom rubric below — unknown keys are rejected.
        Custom rubric criteria drive the real panel scorecard.
      </div>

      {/* ─────────── (A) Round loop ─────────── */}
      <Card className="mt-6 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Default interview loop</h2>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={addRound} disabled={roundsBusy}>
              Add round
            </Button>
            <Button size="sm" onClick={saveRounds} disabled={roundsBusy}>
              Save loop
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              onClick={() => {
                setNotice(null);
                clearRounds.mutate({});
              }}
              disabled={roundsBusy || rounds.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>

        {rounds.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">
            No default loop. Add rounds and save, or leave empty — new requisitions build their plan
            from scratch.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {rounds.map((r, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 items-end gap-3 rounded-lg border border-neutral-200 bg-neutral-50/40 p-3"
              >
                <div className="col-span-1">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-500">#</span>
                  <div className="py-2 text-sm font-medium text-neutral-700">{r.roundNumber}</div>
                </div>
                <div className="col-span-3">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Round name
                  </span>
                  <Input
                    value={r.roundName}
                    onChange={(e) => updateRound(idx, { roundName: e.target.value })}
                    placeholder="e.g. Technical screen"
                    size="sm"
                  />
                </div>
                <div className="col-span-2">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Duration (min)
                  </span>
                  <Input
                    type="number"
                    value={String(r.durationMinutes)}
                    onChange={(e) =>
                      updateRound(idx, { durationMinutes: Number(e.target.value) || 0 })
                    }
                    size="sm"
                  />
                </div>
                <div className="col-span-2">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-500">Mode</span>
                  <Select
                    options={MODE_OPTIONS}
                    value={r.mode}
                    onValueChange={(v) => updateRound(idx, { mode: v as InterviewMode })}
                    size="sm"
                  />
                </div>
                <div className="col-span-3">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Scorecard
                  </span>
                  <Select
                    options={scorecardOptions}
                    value={r.scorecardTemplateKey}
                    onValueChange={(v) => updateRound(idx, { scorecardTemplateKey: v })}
                    size="sm"
                  />
                </div>
                <div className="col-span-11">
                  <span className="mb-1 block text-[11px] font-medium text-neutral-500">
                    Competency focus (comma-separated)
                  </span>
                  <Input
                    value={r.competencyText}
                    onChange={(e) => updateRound(idx, { competencyText: e.target.value })}
                    placeholder="e.g. system_design, ownership"
                    size="sm"
                  />
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button
                    size="sm"
                    variant="tertiary"
                    onClick={() => removeRound(idx)}
                    disabled={roundsBusy}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ─────────── (B) Custom scorecards ─────────── */}
      <ScorecardSection
        custom={custom}
        onChanged={async () => {
          await scorecardsQuery.refetch();
        }}
        setNotice={setNotice}
      />
    </div>
  );
}

function ScorecardSection({
  custom,
  onChanged,
  setNotice,
}: {
  custom: { scorecardKey: string; label: string; criteria: ScorecardTemplateCriterion[] }[];
  onChanged: () => Promise<void>;
  setNotice: (s: string | null) => void;
}) {
  const [scorecardKey, setScorecardKey] = useState("");
  const [label, setLabel] = useState("");
  const [criteriaText, setCriteriaText] = useState("");

  const upsert = trpc.upsertScorecardTemplate.useMutation({
    onSuccess: async (res) => {
      await onChanged();
      setNotice(`Saved custom scorecard “${res.row.label}”.`);
      setScorecardKey("");
      setLabel("");
      setCriteriaText("");
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });
  const del = trpc.deleteScorecardTemplate.useMutation({
    onSuccess: async () => {
      await onChanged();
      setNotice("Custom scorecard deleted.");
    },
    onError: (err) => {
      setNotice(`Delete failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function slugify(v: string): string {
    return v
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  // "Label | key" per line, or just "Label" (key derived by slug).
  function parseCriteria(text: string): ScorecardTemplateCriterion[] {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [labelPart, keyPart] = line.split("|").map((s) => s.trim());
        const l = labelPart ?? line;
        return { label: l, key: keyPart ? slugify(keyPart) : slugify(l) };
      })
      .filter((c) => c.key.length > 0 && c.label.length > 0);
  }

  function edit(sc: {
    scorecardKey: string;
    label: string;
    criteria: ScorecardTemplateCriterion[];
  }) {
    setScorecardKey(sc.scorecardKey);
    setLabel(sc.label);
    setCriteriaText(sc.criteria.map((c) => `${c.label} | ${c.key}`).join("\n"));
  }

  function save() {
    setNotice(null);
    const criteria = parseCriteria(criteriaText);
    upsert.mutate({ scorecardKey: slugify(scorecardKey), label, criteria });
  }

  const busy = upsert.isPending || del.isPending;

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-sm font-semibold text-neutral-900">Custom scorecards</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Rubrics beyond the four built-ins. Each criterion drives a 1–5 score on the panel scorecard.
      </p>

      {custom.length > 0 ? (
        <div className="mt-4 space-y-2">
          {custom.map((sc) => (
            <div
              key={sc.scorecardKey}
              className="flex items-start justify-between rounded-lg border border-neutral-200 bg-neutral-50/40 p-3"
            >
              <div>
                <div className="text-sm font-medium text-neutral-900">
                  {sc.label}{" "}
                  <code className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
                    {sc.scorecardKey}
                  </code>
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  {sc.criteria.map((c) => c.label).join(" · ")}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => edit(sc)} disabled={busy}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={() => {
                    setNotice(null);
                    del.mutate({ scorecardKey: sc.scorecardKey });
                  }}
                  disabled={busy}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-neutral-500">No custom scorecards yet.</p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-neutral-100 pt-5">
        <div>
          <span className="mb-1 block text-[11px] font-medium text-neutral-500">
            Key (snake_case)
          </span>
          <Input
            value={scorecardKey}
            onChange={(e) => setScorecardKey(e.target.value)}
            placeholder="e.g. security_panel"
            size="sm"
          />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-medium text-neutral-500">Label</span>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Security panel"
            size="sm"
          />
        </div>
        <div className="col-span-2">
          <span className="mb-1 block text-[11px] font-medium text-neutral-500">
            Criteria — one per line, &quot;Label | key&quot; (key optional, derived from label)
          </span>
          <textarea
            value={criteriaText}
            onChange={(e) => setCriteriaText(e.target.value)}
            rows={5}
            placeholder={"Threat modelling | threat_modelling\nSecure coding\nIncident response"}
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>
        <div className="col-span-2 flex justify-end">
          <Button
            size="sm"
            onClick={save}
            disabled={busy || !scorecardKey.trim() || !label.trim() || !criteriaText.trim()}
          >
            Save scorecard
          </Button>
        </div>
      </div>
    </Card>
  );
}
