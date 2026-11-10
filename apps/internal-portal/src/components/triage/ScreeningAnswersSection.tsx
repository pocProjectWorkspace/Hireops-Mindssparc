"use client";

import { useState } from "react";
import type {
  ApplicationScreeningAnswers,
  KnockoutSummary,
  ScreeningAnswersInput,
} from "@hireops/api-types";
import { NOTICE_PERIOD_MAX_DAYS } from "@hireops/api-types";
import { Button } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { paiseToInr } from "@/components/comp/format";
import { KnockoutChip } from "./ScreeningChips";

/**
 * PC-7 — the candidate drawer's "Screening answers" card: notice period,
 * current location, current / expected CTC, who supplied them, and the
 * knockout verdict (each non-passing knockout listed as FAIL or UNKNOWN).
 *
 * Recruiter edit writes through updateApplicationScreeningAnswers (source
 * 'recruiter'), which re-evaluates the requisition's knockouts server-side.
 * Pay rows and inputs only render when the API reports `compVisible`; the
 * server refuses pay edits from other roles regardless.
 */

const inputCls =
  "h-9 w-full rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

const SOURCE_LABEL: Record<string, string> = {
  candidate: "candidate",
  recruiter: "recruiter",
  partner: "partner",
  import: "import",
  parsed_cv: "parsed CV",
};

function rupeesString(paise: number | null): string {
  return paise == null ? "" : String(Math.round(paise / 100));
}

/** "" → null (clear); digits → number; anything else → undefined (invalid). */
function parseWhole(v: string, max: number): number | null | undefined {
  const t = v.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n <= max ? n : undefined;
}

export function ScreeningAnswersSection({
  applicationId,
  screening,
  knockout,
  onSaved,
}: {
  applicationId: string;
  screening: ApplicationScreeningAnswers;
  knockout: KnockoutSummary;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [location, setLocation] = useState("");
  const [currentCtc, setCurrentCtc] = useState("");
  const [expectedCtc, setExpectedCtc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const save = trpc.updateApplicationScreeningAnswers.useMutation({
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
    onError: (err) => setFormError(err.message),
  });

  function startEdit() {
    setNotice(
      screening.noticePeriodFrom === "application" && screening.noticePeriodDays != null
        ? String(screening.noticePeriodDays)
        : "",
    );
    setLocation(screening.currentLocation ?? "");
    setCurrentCtc(rupeesString(screening.currentSalaryInrPaise));
    setExpectedCtc(rupeesString(screening.expectedSalaryInrPaise));
    setFormError(null);
    setEditing(true);
  }

  function submit() {
    const n = parseWhole(notice, NOTICE_PERIOD_MAX_DAYS);
    if (n === undefined) return setFormError("Notice period: whole days, 0–365.");
    const answers: ScreeningAnswersInput = {
      noticePeriodDays: n,
      currentLocation: location.trim() === "" ? null : location.trim(),
    };
    if (screening.compVisible) {
      const cur = parseWhole(currentCtc, 1_000_000_000);
      const exp = parseWhole(expectedCtc, 1_000_000_000);
      if (cur === undefined || exp === undefined)
        return setFormError("CTC: whole rupees per year.");
      answers.currentSalaryInrPaise = cur == null ? null : cur * 100;
      answers.expectedSalaryInrPaise = exp == null ? null : exp * 100;
    }
    setFormError(null);
    save.mutate({ applicationId, answers });
  }

  const fails = knockout.items.filter((i) => i.result === "fail");
  const unknowns = knockout.items.filter((i) => i.result === "unknown");

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Screening answers
        </h3>
        {!editing ? (
          <button
            type="button"
            onClick={startEdit}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            Edit
          </button>
        ) : null}
      </div>

      {!editing ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-neutral-500">Notice period</dt>
          <dd className="text-neutral-900">
            {screening.noticePeriodDays != null ? (
              <>
                {screening.noticePeriodDays} days
                {screening.noticePeriodFrom === "parsed_cv" ? (
                  <span className="text-neutral-400"> · from CV</span>
                ) : null}
              </>
            ) : (
              <span className="text-neutral-400">Not stated</span>
            )}
          </dd>
          <dt className="text-neutral-500">Current location</dt>
          <dd className="text-neutral-900">
            {screening.currentLocation ?? <span className="text-neutral-400">Not stated</span>}
          </dd>
          {screening.compVisible ? (
            <>
              <dt className="text-neutral-500">Current CTC</dt>
              <dd className="tabular-nums text-neutral-900">
                {paiseToInr(screening.currentSalaryInrPaise) ?? (
                  <span className="text-neutral-400">Not stated</span>
                )}
              </dd>
              <dt className="text-neutral-500">Expected CTC</dt>
              <dd className="tabular-nums text-neutral-900">
                {paiseToInr(screening.expectedSalaryInrPaise) ?? (
                  <span className="text-neutral-400">Not stated</span>
                )}
              </dd>
            </>
          ) : (
            <>
              <dt className="text-neutral-500">CTC</dt>
              <dd className="text-neutral-400">Restricted for your role</dd>
            </>
          )}
          {screening.source ? (
            <>
              <dt className="text-neutral-500">Supplied by</dt>
              <dd className="text-neutral-600">
                {SOURCE_LABEL[screening.source] ?? screening.source}
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
            Notice period (days)
            <input
              className={inputCls}
              inputMode="numeric"
              value={notice}
              placeholder={
                screening.noticePeriodFrom === "parsed_cv" && screening.noticePeriodDays != null
                  ? `CV says ${screening.noticePeriodDays}`
                  : "e.g. 60"
              }
              onChange={(e) => setNotice(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-600">
            Current location
            <input
              className={inputCls}
              value={location}
              placeholder="City"
              maxLength={200}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
          {screening.compVisible ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-neutral-600">
                Current CTC (₹ / year)
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={currentCtc}
                  onChange={(e) => setCurrentCtc(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-600">
                Expected CTC (₹ / year)
                <input
                  className={inputCls}
                  inputMode="numeric"
                  value={expectedCtc}
                  onChange={(e) => setExpectedCtc(e.target.value)}
                />
              </label>
            </>
          ) : null}
          {formError ? (
            <p className="col-span-2 text-xs text-status-error-700">{formError}</p>
          ) : null}
          <div className="col-span-2 mt-1 flex gap-2">
            <Button size="sm" variant="primary" onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {fails.length > 0 || unknowns.length > 0 ? (
        <div className="mt-3 border-t border-neutral-100 pt-3">
          <div className="mb-1.5">
            <KnockoutChip knockout={knockout} />
          </div>
          <ul className="space-y-0.5 text-xs">
            {fails.map((i) => (
              <li key={`f-${i.knockoutId}`} className="text-status-error-700">
                Fail · {i.label ?? i.fieldPath ?? "knockout"}
              </li>
            ))}
            {unknowns.map((i) => (
              <li key={`u-${i.knockoutId}`} className="text-neutral-600">
                Unknown ({i.reason === "field_missing" ? "no answer to check" : "not evaluable"})
                {" · "}
                {i.label ?? i.fieldPath ?? "knockout"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
