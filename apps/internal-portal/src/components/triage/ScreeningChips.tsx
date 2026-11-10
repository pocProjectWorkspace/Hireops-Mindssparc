"use client";

import type { ApplicationScreeningAnswers, KnockoutSummary } from "@hireops/api-types";
import { Badge } from "@/components/ui";
import { paiseToLpa } from "@/components/comp/format";

/**
 * PC-7 — compact screening chips for a candidate row / the drawer header:
 * notice period, current location, current → expected CTC, and the knockout
 * verdict. Pay only renders when the API says the caller may see it
 * (`compVisible`); the server already nulled the figures otherwise, so this is
 * presentation, not the gate.
 *
 * Knockout states are deliberately distinct: a FAIL is a real breach of the
 * requisition's bar; UNKNOWN means there was no answer to judge — never a fail.
 */
export function ScreeningChips({
  screening,
  knockout,
  hideNotice = false,
}: {
  screening: ApplicationScreeningAnswers;
  knockout?: KnockoutSummary;
  /** The drawer already renders notice elsewhere in some layouts. */
  hideNotice?: boolean;
}) {
  const notice =
    !hideNotice && screening.noticePeriodDays != null
      ? `${screening.noticePeriodDays}d notice${screening.noticePeriodFrom === "parsed_cv" ? " (CV)" : ""}`
      : null;
  const current = screening.compVisible ? paiseToLpa(screening.currentSalaryInrPaise) : null;
  const expected = screening.compVisible ? paiseToLpa(screening.expectedSalaryInrPaise) : null;
  const pay =
    current && expected
      ? `${current.replace(" LPA", "")} → ${expected}`
      : expected
        ? `Exp ${expected}`
        : current
          ? `Cur ${current}`
          : null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {notice ? (
        <span title={noticeTitle(screening)}>
          <Badge tone="info">{notice}</Badge>
        </span>
      ) : null}
      {screening.currentLocation ? (
        <Badge tone="neutral" className="max-w-[12rem] truncate">
          {screening.currentLocation}
        </Badge>
      ) : null}
      {pay ? (
        <span title="Current → expected CTC">
          <Badge tone="neutral" className="tabular-nums">
            {pay}
          </Badge>
        </span>
      ) : null}
      {knockout ? <KnockoutChip knockout={knockout} /> : null}
    </span>
  );
}

function noticeTitle(s: ApplicationScreeningAnswers): string {
  if (s.noticePeriodFrom === "parsed_cv") return "Notice period read from the CV";
  return s.source ? `Notice period supplied by: ${s.source.replace(/_/g, " ")}` : "Notice period";
}

/**
 * Knockout verdict chip — fail (error) or unknown (warning). No chip when every
 * knockout passed: the summary can't tell "all passed" from "the req has no
 * knockouts", and a green chip on every row of a knockout-less req is noise.
 */
export function KnockoutChip({ knockout }: { knockout: KnockoutSummary }) {
  const fails = knockout.items.filter((i) => i.result === "fail");
  const unknowns = knockout.items.filter((i) => i.result === "unknown");
  const describe = (xs: typeof knockout.items) =>
    xs.map((i) => i.label ?? i.fieldPath ?? "knockout").join("; ");
  if (knockout.failCount > 0) {
    return (
      <span title={`Failed: ${describe(fails)}`}>
        <Badge tone="error">
          {knockout.failCount === 1 ? "Knockout failed" : `${knockout.failCount} knockouts failed`}
        </Badge>
      </span>
    );
  }
  if (knockout.unknownCount > 0) {
    return (
      <span title={`Unknown, not a fail: ${describe(unknowns)}`}>
        <Badge tone="warning">
          {knockout.unknownCount === 1
            ? "1 knockout unknown"
            : `${knockout.unknownCount} knockouts unknown`}
        </Badge>
      </span>
    );
  }
  return null;
}
