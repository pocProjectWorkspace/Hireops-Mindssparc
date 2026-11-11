"use client";

import { useState } from "react";
import {
  DEFAULT_DIVERSE_SLATE_COUNTED_STAGES,
  DIVERSE_SLATE_MIN_MAX,
  DIVERSE_SLATE_VIEW_ROLES,
  DIVERSITY_SELF_ID_DISCLOSURE,
  DIVERSITY_SELF_ID_DISCLOSURE_VERSION,
  applicationStageSchema,
  defaultDiversityCategories,
  diversitySlateSettingsSchema,
  type ApplicationStage,
  type DiversityCategory,
  type DiversitySlateSettings,
} from "@hireops/api-types";
import { Button } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { useApplicationStageLabel } from "@/components/TenantLabelsProvider";

/**
 * PC-26 admin editor for the tenant `diversitySlate` block.
 *
 * Config only — this page never shows any candidate's answer or any count.
 * Categories and options are edited as data (key / label / counts toward the
 * slate) so nothing about what "diverse" means is fixed in code; the platform
 * default is one Gender question where woman / non-binary / self-described
 * count. Stored option VALUES should not be renamed once answers exist (a
 * renamed value no longer matches stored answers) — the copy says so.
 */

const ALL_STAGES = applicationStageSchema.options;

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40) || "option"
  );
}

export function DiversitySlateClient({ initial }: { initial: DiversitySlateSettings }) {
  const utils = trpc.useUtils();
  // CFG-LITE — tenant stage wording.
  const applicationStageLabel = useApplicationStageLabel();
  const [draft, setDraft] = useState<DiversitySlateSettings>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = trpc.updateDiversitySlateSettings.useMutation({
    onSuccess: (res) => {
      setDraft(res.settings);
      setNotice("Saved. The new settings apply immediately.");
      setError(null);
      void utils.getDiversitySlateSettings.invalidate();
    },
  });

  const validation = diversitySlateSettingsSchema.safeParse(draft);

  function patch(next: Partial<DiversitySlateSettings>) {
    setDraft((d) => ({ ...d, ...next }));
    setNotice(null);
  }
  function patchCategory(i: number, next: DiversityCategory) {
    patch({ categories: draft.categories.map((c, j) => (j === i ? next : c)) });
  }
  function toggleStage(stage: ApplicationStage) {
    const has = draft.countedStages.includes(stage);
    patch({
      countedStages: has
        ? draft.countedStages.filter((s) => s !== stage)
        : ALL_STAGES.filter((s) => s === stage || draft.countedStages.includes(s)),
    });
  }

  async function onSave() {
    setError(null);
    if (!validation.success) {
      setError(validation.error.issues[0]?.message ?? "Some settings are invalid.");
      return;
    }
    try {
      await save.mutateAsync(validation.data);
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
      setError((prev) => prev ?? "Could not save. Please try again.");
    }
  }

  return (
    <PageContainer variant="measure" className="flex flex-col gap-6">
      <PageHeader
        title="Diverse slate"
        subtitle="Flag roles whose interview slate has fewer candidates who self-identify as diverse than required. Flags only: nothing here blocks a stage move or an offer."
        right={
          <Button onClick={() => void onSave()} disabled={save.isPending} loading={save.isPending}>
            Save
          </Button>
        }
      />

      {notice ? (
        <p className="rounded-md bg-status-positive-50 px-3 py-2 text-sm text-status-positive-700">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700"
        >
          {error}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4 p-6">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="h-4 w-4 rounded border-neutral-300 text-brand-600"
          />
          Collect voluntary self-identification and check diverse slates
        </label>
        <p className="text-xs text-neutral-500">
          When on, the apply form and the candidate portal show an optional section (default
          &ldquo;Prefer not to say&rdquo;) and requisitions can require a diverse slate. When off,
          nothing is collected and no role is flagged. Answers already given stay stored until the
          candidate withdraws them.
        </p>
        <div className="max-w-xs">
          <label
            htmlFor="diverse-slate-default-min"
            className="mb-1 block text-xs font-medium text-neutral-700"
          >
            Default minimum diverse candidates in a slate
          </label>
          <input
            id="diverse-slate-default-min"
            type="number"
            min={1}
            max={DIVERSE_SLATE_MIN_MAX}
            className={inputCls}
            value={draft.defaultMin}
            onChange={(e) => patch({ defaultMin: Math.trunc(Number(e.target.value)) || 1 })}
          />
          <p className="mt-1 text-xs text-neutral-500">
            Used when a role requires a diverse slate without its own minimum.
          </p>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-6">
        <h2 className="text-sm font-semibold text-neutral-900">Stages that make up the slate</h2>
        <p className="text-xs text-neutral-500">
          A candidate counts while their application sits in one of these stages. Platform default:{" "}
          {DEFAULT_DIVERSE_SLATE_COUNTED_STAGES.map(applicationStageLabel).join(", ")}.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ALL_STAGES.map((stage) => (
            <label key={stage} className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={draft.countedStages.includes(stage)}
                onChange={() => toggleStage(stage)}
                className="h-4 w-4 rounded border-neutral-300 text-brand-600"
              />
              {applicationStageLabel(stage)}
            </label>
          ))}
        </div>
      </Card>

      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">Self-identification questions</h2>
          <Button
            variant="tertiary"
            size="sm"
            onClick={() => patch({ categories: defaultDiversityCategories() })}
          >
            Reset to platform default
          </Button>
        </div>
        <p className="text-xs text-neutral-500">
          Each question is optional for candidates and always offers &ldquo;Prefer not to
          say&rdquo;. Tick &ldquo;Counts&rdquo; for the answers that count toward the slate.
          Don&apos;t rename an option&apos;s stored value once candidates have answered; add a new
          option instead.
        </p>
        {draft.categories.map((c, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem_auto]">
              <input
                className={inputCls}
                value={c.label}
                aria-label="Question label"
                onChange={(e) => patchCategory(i, { ...c, label: e.target.value })}
              />
              <input
                className={`${inputCls} font-mono text-xs`}
                value={c.key}
                aria-label="Stored key"
                onChange={(e) => patchCategory(i, { ...c, key: e.target.value })}
              />
              <Button
                variant="tertiary"
                size="sm"
                disabled={draft.categories.length <= 1}
                onClick={() => patch({ categories: draft.categories.filter((_, j) => j !== i) })}
              >
                Remove question
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {c.options.map((o, j) => (
                <li
                  key={j}
                  className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_12rem_6rem_auto]"
                >
                  <input
                    className={inputCls}
                    value={o.label}
                    aria-label="Option label"
                    onChange={(e) =>
                      patchCategory(i, {
                        ...c,
                        options: c.options.map((x, k) =>
                          k === j ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <input
                    className={`${inputCls} font-mono text-xs`}
                    value={o.value}
                    aria-label="Stored value"
                    onChange={(e) =>
                      patchCategory(i, {
                        ...c,
                        options: c.options.map((x, k) =>
                          k === j ? { ...x, value: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <label className="flex items-center gap-1.5 text-xs text-neutral-700">
                    <input
                      type="checkbox"
                      checked={o.countsAsDiverse}
                      onChange={(e) =>
                        patchCategory(i, {
                          ...c,
                          options: c.options.map((x, k) =>
                            k === j ? { ...x, countsAsDiverse: e.target.checked } : x,
                          ),
                        })
                      }
                      className="h-4 w-4 rounded border-neutral-300 text-brand-600"
                    />
                    Counts
                  </label>
                  <Button
                    variant="tertiary"
                    size="sm"
                    disabled={c.options.length <= 1}
                    onClick={() =>
                      patchCategory(i, { ...c, options: c.options.filter((_, k) => k !== j) })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const label = "New option";
                  patchCategory(i, {
                    ...c,
                    options: [
                      ...c.options,
                      {
                        label,
                        value: `${slugify(label)}_${c.options.length + 1}`,
                        countsAsDiverse: false,
                      },
                    ],
                  });
                }}
              >
                Add option
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={draft.categories.length >= 5}
            onClick={() =>
              patch({
                categories: [
                  ...draft.categories,
                  {
                    key: `question_${draft.categories.length + 1}`,
                    label: "New question",
                    options: [{ value: "option_1", label: "Option 1", countsAsDiverse: false }],
                  },
                ],
              })
            }
          >
            Add question
          </Button>
        </div>
      </Card>

      <Card className="flex flex-col gap-2 p-6">
        <h2 className="text-sm font-semibold text-neutral-900">What candidates are told</h2>
        <p className="text-xs text-neutral-500">
          Platform wording, version {DIVERSITY_SELF_ID_DISCLOSURE_VERSION}. Pending legal review;
          any change to it is a new version.
        </p>
        <div className="flex flex-col gap-2 rounded-md bg-neutral-50 p-3 text-sm text-neutral-700">
          <p className="font-medium">{DIVERSITY_SELF_ID_DISCLOSURE.title}</p>
          {DIVERSITY_SELF_ID_DISCLOSURE.body.map((p, i) => (
            <p key={i}>{p.split("{company}").join("Your organisation")}</p>
          ))}
        </div>
        <p className="text-xs text-neutral-500">
          Who sees counts: {DIVERSE_SLATE_VIEW_ROLES.join(", ")}. Counts are per role only; no
          screen lists which candidates were counted, and answers never appear on candidate
          profiles, scorecards, the partner portal, exports or AI prompts.
        </p>
      </Card>
    </PageContainer>
  );
}
