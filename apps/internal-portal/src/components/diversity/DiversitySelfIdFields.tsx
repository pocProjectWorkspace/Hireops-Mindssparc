"use client";

import {
  DIVERSITY_PREFER_NOT_TO_SAY,
  type DiversityCaptureConfig,
  type DiversitySelfIdAnswer,
} from "@hireops/api-types";

/** Per-category selection; missing key = "prefer not to say". */
export type DiversitySelections = Record<string, string>;

export function selectionsFromAnswers(answers: DiversitySelfIdAnswer[]): DiversitySelections {
  const out: DiversitySelections = {};
  for (const a of answers) out[a.categoryKey] = a.value;
  return out;
}

/**
 * Every configured category, with "prefer not to say" for any left unanswered
 * — so a submission from the profile page withdraws a cleared answer.
 */
export function selectionsToAnswers(
  config: DiversityCaptureConfig,
  selections: DiversitySelections,
): DiversitySelfIdAnswer[] {
  return config.categories.map((c) => ({
    categoryKey: c.key,
    value: selections[c.key] ?? DIVERSITY_PREFER_NOT_TO_SAY,
  }));
}

/** True when at least one category carries a real (non-default) answer. */
export function hasAnyAnswer(selections: DiversitySelections): boolean {
  return Object.values(selections).some((v) => v && v !== DIVERSITY_PREFER_NOT_TO_SAY);
}

/**
 * PC-26 — the optional diversity self-identification section, shared by the
 * public apply form and the candidate portal profile. Renders the versioned
 * disclosure copy served by the API, then one radio group per configured
 * category with "Prefer not to say" pre-selected. Renders nothing when the
 * tenant has the feature off.
 */
export function DiversitySelfIdFields({
  config,
  selections,
  onChange,
  idPrefix,
  showTitle = true,
}: {
  config: DiversityCaptureConfig;
  selections: DiversitySelections;
  onChange: (next: DiversitySelections) => void;
  idPrefix: string;
  showTitle?: boolean;
}) {
  if (!config.enabled || config.categories.length === 0) return null;
  return (
    <fieldset
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4"
      data-disclosure-version={config.disclosureVersion}
    >
      {showTitle ? (
        <legend className="px-1 text-sm font-semibold text-neutral-800">{config.title}</legend>
      ) : null}
      <div className="flex flex-col gap-2 text-sm text-neutral-600">
        {config.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {config.categories.map((c) => {
        const current = selections[c.key] ?? DIVERSITY_PREFER_NOT_TO_SAY;
        const options = [
          { value: DIVERSITY_PREFER_NOT_TO_SAY, label: config.preferNotToSayLabel },
          ...c.options,
        ];
        return (
          <div key={c.key} role="radiogroup" aria-label={c.label} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-neutral-700">{c.label}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {options.map((o) => {
                const id = `${idPrefix}-${c.key}-${o.value}`;
                return (
                  <label
                    key={o.value}
                    htmlFor={id}
                    className="flex min-h-[32px] items-center gap-2 text-sm text-neutral-700"
                  >
                    <input
                      id={id}
                      type="radio"
                      name={`${idPrefix}-${c.key}`}
                      value={o.value}
                      checked={current === o.value}
                      onChange={() => {
                        const next = Object.fromEntries(
                          Object.entries(selections).filter(([k]) => k !== c.key),
                        );
                        if (o.value !== DIVERSITY_PREFER_NOT_TO_SAY) next[c.key] = o.value;
                        onChange(next);
                      }}
                      className="h-4 w-4 border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500"
                    />
                    {o.label}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}
