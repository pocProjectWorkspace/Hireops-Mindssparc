"use client";

import { useState } from "react";
import { Button, Select } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * PC-10 — "Can't attend".
 *
 * Two shapes:
 *   - `self` (the panel surface): the signed-in panellist declares they can't
 *     make it. One reason box, one button.
 *   - recruiter (the candidate drawer): pick which panellist can't attend, and
 *     optionally swap in a replacement from the round's panel pool.
 *
 * Either way the server records the conflict, and — unless a replacement who
 * is free at the same time keeps the booking — sends the candidate new times
 * automatically and tells the recruiter + remaining panel. Nobody has to chase.
 */
export function CannotAttendControl({
  interviewId,
  panel,
  self = false,
  onChanged,
}: {
  interviewId: string;
  panel: { membershipId: string; name: string | null }[];
  self?: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<string>(panel[0]?.membershipId ?? "");
  const [replacement, setReplacement] = useState<string>("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const replacements = trpc.listPanelReplacementCandidates.useQuery(
    { interviewId },
    { enabled: open && !self },
  );
  const mark = trpc.markPanelistCannotAttend.useMutation({
    onSuccess: (res) => {
      setOpen(false);
      setNotice(
        res.replacedWith && !res.offerId
          ? "Panellist swapped. The booked time still works, so the candidate is unaffected."
          : res.offerId
            ? `The candidate has been sent ${res.slotsOffered} new time${res.slotsOffered === 1 ? "" : "s"} to choose from.`
            : "No other common time was found. The recruiter has been alerted.",
      );
      onChanged?.();
    },
  });

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="tertiary" size="sm" type="button" onClick={() => setOpen(true)}>
          Can&apos;t attend…
        </Button>
        {notice ? <span className="text-xs text-status-success-700">{notice}</span> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-status-warning-200 bg-status-warning-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-status-warning-800">
        {self ? "I can't attend this interview" : "A panellist can't attend"}
      </p>
      {!self ? (
        <Select
          label="Who can't attend"
          size="sm"
          options={panel.map((p) => ({
            value: p.membershipId,
            label: p.name ?? p.membershipId.slice(0, 8),
          }))}
          value={who}
          onValueChange={setWho}
        />
      ) : null}
      {!self ? (
        <Select
          label="Replacement from the panel pool (optional)"
          size="sm"
          placeholder={
            replacements.isLoading
              ? "Loading…"
              : (replacements.data?.items.length ?? 0) === 0
                ? "No pool for this round — keep the same panel"
                : "Keep the same panel"
          }
          options={(replacements.data?.items ?? []).map((r) => ({
            value: r.membershipId,
            label: r.name ?? r.membershipId.slice(0, 8),
          }))}
          value={replacement}
          onValueChange={setReplacement}
          disabled={(replacements.data?.items.length ?? 0) === 0}
        />
      ) : null}
      <label className="block">
        <span className="text-sm font-medium text-neutral-700">Reason (optional)</span>
        <input
          type="text"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. travelling"
          className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm"
        />
      </label>
      <p className="text-xs text-neutral-600">
        The candidate will be offered new times automatically, and the recruiter and the rest of the
        panel will be told.
      </p>
      {mark.error ? <p className="text-xs text-status-error-700">{mark.error.message}</p> : null}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          type="button"
          loading={mark.isPending}
          disabled={mark.isPending || (!self && !who)}
          onClick={() =>
            mark.mutate({
              interviewId,
              membershipId: self ? undefined : who,
              reason: reason.trim() || undefined,
              replacementMembershipId: !self && replacement ? replacement : undefined,
            })
          }
        >
          Confirm
        </Button>
        <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </div>
  );
}
