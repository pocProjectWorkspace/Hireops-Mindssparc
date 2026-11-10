"use client";

import { useState } from "react";
import { Button } from "@hireops/ui";
import { cn } from "@/components/ui/cn";
import { formatSlotRange, groupByLocalDay, viewerTimeZone } from "./slot-format";

/**
 * PC-9 — the candidate's slot list, shared by the public pick-a-time page and
 * the candidate portal. Times are rendered in the CANDIDATE'S OWN browser time
 * zone and the zone is named. One choice, one confirm button — nothing is
 * pre-selected.
 */
export function SlotPicker({
  slots,
  busy,
  error,
  confirmLabel = "Confirm this time",
  onPick,
}: {
  slots: { start: string; end: string }[];
  busy: boolean;
  error: string | null;
  confirmLabel?: string;
  onPick: (start: string) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const stillThere = chosen && slots.some((s) => s.start === chosen) ? chosen : null;

  if (slots.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        None of the offered times is still free. Your recruiter has the details and will send new
        times.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-500">
        Times shown in your time zone ({viewerTimeZone()}).
      </p>
      {groupByLocalDay(slots).map(([day, list]) => (
        <div key={day}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            {day}
          </p>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label={day}>
            {list.map((s) => (
              <button
                key={s.start}
                type="button"
                role="radio"
                aria-checked={stillThere === s.start}
                onClick={() => setChosen(s.start)}
                disabled={busy}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                  stillThere === s.start
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-neutral-300 bg-white text-neutral-800 hover:border-brand-400",
                )}
              >
                {formatSlotRange(s.start, s.end)}
              </button>
            ))}
          </div>
        </div>
      ))}
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800"
        >
          {error}
        </div>
      ) : null}
      <div>
        <Button
          variant="primary"
          disabled={!stillThere || busy}
          loading={busy}
          onClick={() => stillThere && onPick(stillThere)}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/** Candidate-facing copy for a refused pick. */
export function pickRefusalMessage(reason: string): string {
  switch (reason) {
    case "slot_taken":
      return "Sorry, that time was just taken. Here are the times that are still free.";
    case "already_booked":
      return "You've already picked a time for this interview.";
    case "offer_expired":
    case "expired":
      return "This link has expired. Please contact your recruiter for new times.";
    case "offer_closed":
    case "round_already_scheduled":
      return "These times are no longer available — your recruiter has arranged the interview another way.";
    case "slot_not_offered":
      return "That time isn't one of the offered times. Please pick from the list.";
    case "invalid_signature":
    case "malformed":
    case "wrong_action":
      return "This link is invalid. Please contact your recruiter.";
    default:
      return `Something went wrong (${reason}). Please try again or contact your recruiter.`;
  }
}
