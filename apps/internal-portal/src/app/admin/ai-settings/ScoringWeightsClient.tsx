"use client";

import { useMemo, useState } from "react";
import {
  SCORING_WEIGHT_CATEGORIES,
  SCORING_WEIGHTS_TOTAL,
  defaultScoringWeights,
  type ScoringWeights,
  type ScoringWeightCategoryKey,
} from "@hireops/api-types";
import { Input, Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin scoring weight profile editor (CONF-03).
 *
 * Four category inputs (skills / experience / industry / education) that must
 * sum to exactly 100. The copy is deliberately honest: these weights are
 * GRADING GUIDANCE the AI is instructed with, NOT a formula it computes. An
 * LLM leans its judgement toward the emphasised categories; it does not sum
 * weighted sub-scores. When the profile equals the incumbent defaults the
 * scoring prompt is unchanged (the guidance block is opt-in), so this surface
 * only ever *adds* emphasis, never silently alters default behaviour.
 */
export function ScoringWeightsClient({ initialWeights }: { initialWeights: ScoringWeights }) {
  const [weights, setWeights] = useState<ScoringWeights>(initialWeights);
  const [saved, setSaved] = useState<ScoringWeights>(initialWeights);
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateScoringWeights.useMutation({
    onSuccess: (res) => {
      setWeights(res.weights);
      setSaved(res.weights);
      setNotice("Scoring weights saved. New scores use them immediately.");
    },
    onError: (err) => setNotice(`Save failed: ${err.message}`),
  });

  const total = useMemo(
    () => SCORING_WEIGHT_CATEGORIES.reduce((acc, c) => acc + (weights[c.key] ?? 0), 0),
    [weights],
  );
  const sumOk = total === SCORING_WEIGHTS_TOTAL;
  const dirty = useMemo(() => JSON.stringify(weights) !== JSON.stringify(saved), [weights, saved]);

  function patch(key: ScoringWeightCategoryKey, value: number) {
    const v = Number.isNaN(value) ? 0 : Math.max(0, Math.min(100, Math.round(value)));
    setWeights((w) => ({ ...w, [key]: v }));
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-10">
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-900">Scoring weight profile</h2>
          <Badge tone={sumOk ? "neutral" : "warning"}>
            {total} / {SCORING_WEIGHTS_TOTAL}
          </Badge>
        </div>
        <p className="mb-1 text-xs text-neutral-600">
          These weights guide the AI&apos;s grading emphasis — they are instruction, not arithmetic.
          The model is asked to lean its overall judgement toward the higher-weighted categories; it
          does not compute a weighted sum of sub-scores. Weights must total exactly{" "}
          {SCORING_WEIGHTS_TOTAL}.
        </p>
        <p className="mb-4 text-xs text-neutral-500">
          At the default profile the scoring prompt is unchanged from before this setting existed —
          only a non-default profile adds an explicit emphasis instruction and surfaces it on the
          candidate&apos;s score.
        </p>

        {notice ? (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              notice.startsWith("Save failed")
                ? "border-status-error-200 bg-status-error-50 text-status-error-700"
                : "border-status-success-200 bg-status-success-50 text-status-success-700"
            }`}
          >
            {notice}
          </div>
        ) : null}

        <div className="space-y-3">
          {SCORING_WEIGHT_CATEGORIES.map((c) => (
            <div
              key={c.key}
              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_7rem] sm:items-start"
            >
              <div>
                <p className="text-sm font-medium text-neutral-800">{c.label}</p>
                <p className="text-xs text-neutral-500">{c.description}</p>
              </div>
              <Input
                label="Weight"
                type="number"
                min={0}
                max={100}
                step={5}
                value={String(weights[c.key] ?? 0)}
                onChange={(e) => patch(c.key, Number(e.target.value))}
              />
            </div>
          ))}
        </div>

        {!sumOk ? (
          <p className="mt-3 text-xs text-status-error-700">
            Weights currently total {total}. Adjust them to sum to exactly {SCORING_WEIGHTS_TOTAL}{" "}
            before saving.
          </p>
        ) : null}

        <div className="mt-5 flex items-center gap-3">
          <Button
            onClick={() => update.mutate(weights)}
            disabled={!dirty || !sumOk || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save weights"}
          </Button>
          {dirty ? (
            <button
              type="button"
              className="text-sm text-neutral-600 hover:underline"
              onClick={() => {
                setWeights(saved);
                setNotice(null);
              }}
            >
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            className="ml-auto text-xs text-neutral-500 hover:underline"
            onClick={() => setWeights(defaultScoringWeights())}
          >
            Reset to defaults
          </button>
        </div>
      </Card>
    </div>
  );
}
