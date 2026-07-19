"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HrRoundAssessment, HrRoundRecommendation } from "@hireops/api-types";
import { Checkbox, Select } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";
import { handleTRPCError } from "@/lib/trpc-client";
import { Button } from "@/components/ui";

/**
 * HrRoundAssessmentForm (HROPS-01) — the deterministic HR-round assessment.
 *
 * The SAME component is mounted in two places: the HR case detail "HR round"
 * tab and the /hr-rounds "Complete" modal. It seeds from the case's saved
 * assessment (if any) and upserts via saveHrRoundAssessment, then invalidates
 * the case/list/round queries so every surface reflects the save.
 *
 * Layout: a six-item checklist grid, a notes textarea, a 1–5 rating slider with
 * a live "Rating: n/5" label, a recommendation select, and Save. The
 * recommendation is the deterministic gate — the surface reminds the user that
 * advancing to the offer stage requires recommendation = proceed.
 */

const CHECKLIST: { key: ChecklistKey; label: string }[] = [
  { key: "motivationDiscussed", label: "Motivation discussed" },
  { key: "salaryExpectationDiscussed", label: "Salary expectation discussed" },
  { key: "cultureFitAssessed", label: "Culture fit assessed" },
  { key: "workAuthorizationVerified", label: "Work authorization verified" },
  { key: "noticePeriodConfirmed", label: "Notice period confirmed" },
  { key: "relocationWillingness", label: "Willing to relocate" },
];

type ChecklistKey =
  | "motivationDiscussed"
  | "salaryExpectationDiscussed"
  | "cultureFitAssessed"
  | "workAuthorizationVerified"
  | "noticePeriodConfirmed"
  | "relocationWillingness";

const RECOMMENDATION_OPTIONS: { value: HrRoundRecommendation; label: string }[] = [
  { value: "proceed", label: "Proceed — advance to offer" },
  { value: "hold", label: "Hold — needs review" },
  { value: "reject", label: "Reject — do not proceed" },
];

type ChecklistState = Record<ChecklistKey, boolean>;

function seedChecklist(initial: HrRoundAssessment | null): ChecklistState {
  return {
    motivationDiscussed: initial?.motivationDiscussed ?? false,
    salaryExpectationDiscussed: initial?.salaryExpectationDiscussed ?? false,
    cultureFitAssessed: initial?.cultureFitAssessed ?? false,
    workAuthorizationVerified: initial?.workAuthorizationVerified ?? false,
    noticePeriodConfirmed: initial?.noticePeriodConfirmed ?? false,
    relocationWillingness: initial?.relocationWillingness ?? false,
  };
}

export function HrRoundAssessmentForm({
  applicationId,
  initial,
  onSaved,
}: {
  applicationId: string;
  initial: HrRoundAssessment | null;
  /** Called with the saved assessment (e.g. to close a modal). */
  onSaved?: (assessment: HrRoundAssessment) => void;
}) {
  const queryClient = useQueryClient();
  const [checklist, setChecklist] = useState<ChecklistState>(() => seedChecklist(initial));
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [rating, setRating] = useState<number>(initial?.rating ?? 3);
  const [recommendation, setRecommendation] = useState<HrRoundRecommendation>(
    initial?.recommendation ?? "proceed",
  );

  const save = trpc.saveHrRoundAssessment.useMutation({
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [["getHrCaseDetail"]] });
      queryClient.invalidateQueries({ queryKey: [["listHrCases"]] });
      queryClient.invalidateQueries({ queryKey: [["listHrRounds"]] });
      onSaved?.(data.assessment);
    },
    onError: (err) => handleTRPCError(err),
  });

  const onSubmit = () => {
    save.mutate({
      applicationId,
      ...checklist,
      notes: notes.trim() ? notes.trim() : null,
      rating,
      recommendation,
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          HR checklist
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CHECKLIST.map((item) => (
            <label
              key={item.key}
              className="flex cursor-pointer items-center gap-2.5 rounded-md border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-800 hover:border-neutral-300"
            >
              <Checkbox
                checked={checklist[item.key]}
                onCheckedChange={(v) =>
                  setChecklist((prev) => ({ ...prev, [item.key]: v === true }))
                }
              />
              {item.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label
          htmlFor="hr-round-notes"
          className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-neutral-500"
        >
          Notes
        </label>
        <textarea
          id="hr-round-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Summary of the HR conversation — motivation, compensation expectations, availability, any flags."
          className="w-full rounded-md border border-neutral-300 p-3 text-sm text-neutral-900 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-brand-500"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label
              htmlFor="hr-round-rating"
              className="text-xs font-semibold uppercase tracking-wider text-neutral-500"
            >
              Overall rating
            </label>
            <span className="text-sm font-semibold tabular-nums text-neutral-900">
              Rating: {rating}/5
            </span>
          </div>
          <input
            id="hr-round-rating"
            type="range"
            min={1}
            max={5}
            step={1}
            value={rating}
            onChange={(e) => setRating(Number(e.target.value))}
            className="w-full accent-brand-600"
          />
          <div className="mt-1 flex justify-between px-0.5 text-[11px] tabular-nums text-neutral-400">
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Recommendation
          </p>
          <Select
            options={RECOMMENDATION_OPTIONS}
            value={recommendation}
            onValueChange={(v) => setRecommendation(v as HrRoundRecommendation)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-neutral-200 pt-4">
        <p className="text-xs text-neutral-500">
          Advancing to the offer stage requires a saved assessment with recommendation{" "}
          <span className="font-medium text-neutral-700">Proceed</span>.
        </p>
        <Button type="button" onClick={onSubmit} disabled={save.isPending}>
          {save.isPending ? "Saving…" : initial ? "Update assessment" : "Save assessment"}
        </Button>
      </div>
    </div>
  );
}
