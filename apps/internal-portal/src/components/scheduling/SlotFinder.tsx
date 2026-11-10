"use client";

import { useState } from "react";
import { Button } from "@hireops/ui";
import type { ProposeInterviewSlotsOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/components/ui/cn";
import { formatSlotRange, groupByLocalDay, viewerTimeZone } from "./slot-format";

/**
 * PC-8 — "Find common slots" inside the schedule form.
 *
 * Asks proposeInterviewSlots for the times when the WHOLE chosen panel is free
 * (their declared availability − blocked/OOO time − interviews already booked,
 * with the tenant's buffer, notice and horizon). Times render in the
 * recruiter's own browser time zone.
 *
 * The recruiter then either books one time directly (onBook → the existing
 * scheduleInterview) or lets the candidate choose (offerInterviewSlots → the
 * candidate gets a private pick-a-time link). With no common time, the reason
 * is shown and the requisition's recruiter has been emailed.
 */
export function SlotFinder({
  applicationId,
  roundNumber,
  durationMinutes,
  panelMembershipIds,
  leadMembershipId,
  mode,
  meetingUrl,
  allowOffer,
  onBook,
  onOffered,
}: {
  applicationId: string;
  roundNumber: number;
  durationMinutes: number;
  panelMembershipIds: string[];
  leadMembershipId?: string;
  mode: "video" | "onsite" | "phone";
  meetingUrl?: string;
  /** False on a reschedule (the round is still booked — book directly instead). */
  allowOffer: boolean;
  onBook: (startIso: string) => void;
  onOffered: () => void;
}) {
  const utils = trpc.useUtils();
  const [result, setResult] = useState<ProposeInterviewSlotsOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [offerNotice, setOfferNotice] = useState<string | null>(null);

  const offer = trpc.offerInterviewSlots.useMutation({
    onSuccess: (res) => {
      if (res.offerId) {
        setOfferNotice(
          `Sent ${res.slots.length} time${res.slots.length === 1 ? "" : "s"} to ${res.sentTo ?? "the candidate"}. The round is booked as soon as they pick one.`,
        );
        onOffered();
      } else {
        setOfferNotice(res.emptyReason ?? "No time could be offered.");
      }
    },
  });

  async function find() {
    setLoading(true);
    setError(null);
    setSelected([]);
    setOfferNotice(null);
    try {
      const r = await utils.proposeInterviewSlots.fetch({
        applicationId,
        roundNumber,
        durationMinutes,
        panelMembershipIds,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't look up availability.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function toggle(start: string) {
    setSelected((prev) =>
      prev.includes(start) ? prev.filter((s) => s !== start) : [...prev, start],
    );
  }

  const panelEmpty = panelMembershipIds.length === 0;

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-700">Find a time the whole panel is free</p>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void find()}
          disabled={panelEmpty || loading}
          loading={loading}
        >
          Find common slots
        </Button>
      </div>
      {panelEmpty ? (
        <p className="mt-1 text-xs text-neutral-500">Pick at least one panellist first.</p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-status-error-700">{error}</p> : null}

      {result ? (
        result.slots.length === 0 ? (
          <div className="mt-2 rounded-md border border-status-warning-200 bg-status-warning-50 p-2 text-xs text-status-warning-800">
            <p className="font-medium">No common slot.</p>
            <p className="mt-0.5">{result.emptyReason}</p>
            {result.recruiterAlerted ? (
              <p className="mt-1">The requisition&apos;s recruiter has been emailed about this.</p>
            ) : null}
          </div>
        ) : (
          <div className="mt-2">
            <p className="text-xs text-neutral-500">
              {result.totalFree} free {result.totalFree === 1 ? "time" : "times"} ·{" "}
              {result.durationMinutes} min · shown in your time zone ({viewerTimeZone()}). Select
              one to book it, or several to let the candidate choose.
            </p>
            <div className="mt-2 flex flex-col gap-2">
              {groupByLocalDay(result.slots).map(([day, slots]) => (
                <div key={day}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {day}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {slots.map((s) => (
                      <button
                        key={s.start}
                        type="button"
                        aria-pressed={selected.includes(s.start)}
                        onClick={() => toggle(s.start)}
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                          selected.includes(s.start)
                            ? "border-brand-600 bg-brand-600 text-white"
                            : "border-neutral-300 bg-white text-neutral-700 hover:border-brand-400",
                        )}
                      >
                        {formatSlotRange(s.start, s.end)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                type="button"
                disabled={selected.length !== 1}
                onClick={() => selected[0] && onBook(selected[0])}
              >
                Book selected time
              </Button>
              {allowOffer ? (
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  loading={offer.isPending}
                  disabled={offer.isPending}
                  onClick={() =>
                    offer.mutate({
                      applicationId,
                      roundNumber,
                      durationMinutes,
                      mode,
                      meetingUrl: meetingUrl || undefined,
                      panelMembershipIds,
                      leadMembershipId:
                        leadMembershipId && panelMembershipIds.includes(leadMembershipId)
                          ? leadMembershipId
                          : undefined,
                      slotStarts: selected.length > 0 ? selected : undefined,
                    })
                  }
                >
                  {selected.length > 0
                    ? `Let candidate choose (${selected.length})`
                    : `Let candidate choose (top ${result.slots.length})`}
                </Button>
              ) : null}
            </div>
            {offer.error ? (
              <p className="mt-2 text-xs text-status-error-700">{offer.error.message}</p>
            ) : null}
          </div>
        )
      ) : null}
      {offerNotice ? <p className="mt-2 text-xs text-status-success-700">{offerNotice}</p> : null}
    </div>
  );
}
