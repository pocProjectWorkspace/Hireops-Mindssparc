"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui";

/**
 * RO-02 — the wizard v2 "Skill weighting" step, owned by this ticket. Per-skill
 * cards grouped by category chips (name / category / weight slider 1–10 /
 * must-have / min years / notes), plus a "Scoring impact" preview.
 *
 * TRUTHFULNESS NOTE (load-bearing): the preview copy describes what the REAL
 * scoring engine does, verified against packages/ai-scoring/src/prompt.ts and
 * packages/api-types/src/scoring-weights.ts:
 *   • Per-skill weight + must-have are rendered into the AI scoring prompt as a
 *     bulleted list ("skill (weight: N, required/nice-to-have)"). The model is
 *     asked to LEAN its holistic judgement toward higher-weighted/must-have
 *     skills — it is INSTRUCTION, not arithmetic. There is NO weighted-sum, and
 *     NO automatic cap or cutoff. (The prototype's "auto-capped at X%" claim is
 *     a fiction we do not reproduce.)
 *   • Must-have marks a skill required vs nice-to-have in the prompt — emphasis,
 *     not a filter. The real hard gates are knockouts (deterministic, no AI).
 *   • Minimum years per skill is captured for interviewers + future scoring;
 *     the current evaluator checks OVERALL years of experience via a knockout,
 *     not per-skill minimums.
 */

export interface SkillWeightRow {
  key: string;
  skillName: string;
  category: string;
  weight: number; // 1–10 in the editor
  isRequired: boolean;
  minYears: number | null;
  notes: string;
}

/** How many weighted skills reads as "well-covered" — a guideline, not a rule. */
export const RECOMMENDED_SKILL_COUNT = 6;

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

function uid(): string {
  return Math.random().toString(36).slice(2);
}

/** Caption label with dynamic children (avoids the a11y-lint false positive
 *  while staying a real <label>; same approach as the wizard's Field). */
function Lbl({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={className ?? "mb-1 block text-xs font-medium text-neutral-700"}>
      {children}
    </label>
  );
}

export function newSkillRow(partial?: Partial<SkillWeightRow>): SkillWeightRow {
  return {
    key: uid(),
    skillName: "",
    category: "General",
    weight: 5,
    isRequired: true,
    minYears: null,
    notes: "",
    ...partial,
  };
}

function weightLabel(w: number): string {
  if (w >= 9) return "Critical";
  if (w >= 7) return "High";
  if (w >= 4) return "Medium";
  return "Low";
}

export function SkillWeightsEditor({
  skills,
  onChange,
}: {
  skills: SkillWeightRow[];
  onChange: (skills: SkillWeightRow[]) => void;
}) {
  const categories = useMemo(() => {
    const map = new Map<string, SkillWeightRow[]>();
    for (const s of skills) {
      const cat = s.category.trim() || "General";
      const list = map.get(cat) ?? [];
      list.push(s);
      map.set(cat, list);
    }
    return [...map.entries()];
  }, [skills]);

  const totalWeight = useMemo(() => skills.reduce((sum, s) => sum + (s.weight || 0), 0), [skills]);
  const mustHaveCount = useMemo(() => skills.filter((s) => s.isRequired).length, [skills]);

  function update(key: string, patch: Partial<SkillWeightRow>) {
    onChange(skills.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
  function remove(key: string) {
    onChange(skills.filter((s) => s.key !== key));
  }
  function add() {
    onChange([...skills, newSkillRow()]);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {categories.length === 0 ? (
            <span className="text-xs text-neutral-500">No skills yet.</span>
          ) : (
            categories.map(([cat, list]) => (
              <span
                key={cat}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-[11px] text-neutral-600"
              >
                {cat}
                <span className="font-semibold text-neutral-800">{list.length}</span>
              </span>
            ))
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={add}>
          + Add skill
        </Button>
      </div>

      {skills.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          Add at least one skill. Skills feed the AI candidate scoring as weighted guidance.
        </p>
      ) : (
        <div className="space-y-3">
          {skills.map((s) => (
            <div key={s.key} className="rounded-lg border border-neutral-200 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Lbl>Skill</Lbl>
                  <input
                    className={inputCls}
                    value={s.skillName}
                    placeholder="Kafka"
                    onChange={(e) => update(s.key, { skillName: e.target.value })}
                  />
                </div>
                <div>
                  <Lbl>Category</Lbl>
                  <input
                    className={inputCls}
                    value={s.category}
                    placeholder="Infrastructure"
                    onChange={(e) => update(s.key, { category: e.target.value })}
                  />
                </div>
              </div>

              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between">
                  <Lbl className="text-xs font-medium text-neutral-700">Weight</Lbl>
                  <span className="text-xs font-semibold text-neutral-800">
                    {s.weight} · {weightLabel(s.weight)}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={s.weight}
                  onChange={(e) => update(s.key, { weight: Number(e.target.value) })}
                  className="w-full accent-brand-600"
                />
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[auto,1fr]">
                <label className="flex items-center gap-2 text-sm text-neutral-700">
                  <input
                    type="checkbox"
                    checked={s.isRequired}
                    onChange={(e) => update(s.key, { isRequired: e.target.checked })}
                  />
                  Must-have
                </label>
                <div>
                  <Lbl>Min years (optional)</Lbl>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    className={`${inputCls} sm:max-w-[8rem]`}
                    value={s.minYears ?? ""}
                    onChange={(e) =>
                      update(s.key, {
                        minYears:
                          e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                      })
                    }
                  />
                </div>
              </div>

              <div className="mt-3">
                <Lbl>Notes (optional)</Lbl>
                <input
                  className={inputCls}
                  value={s.notes}
                  placeholder="Core to the payments rewrite; not negotiable."
                  onChange={(e) => update(s.key, { notes: e.target.value })}
                />
              </div>

              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  className="text-xs text-status-error-600 hover:underline"
                  onClick={() => remove(s.key)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScoringImpactPanel
        skillCount={skills.length}
        totalWeight={totalWeight}
        mustHaveCount={mustHaveCount}
      />
    </div>
  );
}

function ScoringImpactPanel({
  skillCount,
  totalWeight,
  mustHaveCount,
}: {
  skillCount: number;
  totalWeight: number;
  mustHaveCount: number;
}) {
  const coverage = Math.min(100, Math.round((skillCount / RECOMMENDED_SKILL_COUNT) * 100));
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-4">
      <h3 className="mb-3 text-sm font-semibold text-neutral-900">Scoring impact</h3>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Total weight points" value={String(Math.round(totalWeight * 10) / 10)} />
        <Stat label="Must-have skills" value={String(mustHaveCount)} />
        <Stat
          label={`Coverage (of ${RECOMMENDED_SKILL_COUNT} recommended)`}
          value={`${coverage}%`}
        />
      </div>
      <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-neutral-600">
        <p>
          <span className="font-medium text-neutral-800">How these weights are used:</span> when a
          candidate applies, the AI evaluator receives every skill with its weight and its must-have
          flag, and is asked to lean its overall judgement toward the higher-weighted and must-have
          skills. This is guidance to the model — <span className="font-medium">not</span> a
          weighted-sum calculation, and there is no automatic cap or cutoff.
        </p>
        <p>
          <span className="font-medium text-neutral-800">Must-have</span> marks a skill required (vs
          nice-to-have) in the prompt. It is emphasis, not an automatic filter — the real hard gates
          are the knockouts below.
        </p>
        <p>
          <span className="font-medium text-neutral-800">Minimum years</span> per skill is recorded
          for interviewers and future scoring; today the evaluator checks a candidate&rsquo;s
          overall years of experience through a knockout, not per-skill minimums.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <p className="text-lg font-semibold text-neutral-900">{value}</p>
      <p className="mt-0.5 text-[11px] text-neutral-500">{label}</p>
    </div>
  );
}
