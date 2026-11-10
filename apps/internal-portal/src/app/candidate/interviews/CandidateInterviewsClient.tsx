"use client";

import { useState } from "react";
import { Button } from "@hireops/ui";
import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import type { CandidateInterviewRow, CandidateSlotOfferView } from "@hireops/api-types";
import { MODE_LABEL, formatWhen } from "@/components/candidate/candidate-format";
import { SlotPicker, pickRefusalMessage } from "@/components/scheduling/SlotPicker";

/**
 * Candidate interviews (CAND-01). Upcoming rounds show the schedule, the
 * meeting link (as a link — the REAL external Teams/Zoom URL), and a confirm
 * action. Past rounds surface ONLY the tenant-policy-gated, SCORE-FREE shared
 * summary / recommendation (often null).
 *
 * REFUSALS: no live "Join Interview Room" / in-app video (that's a post-deal
 * connector — the link is the join), no numeric score, no raw panel feedback,
 * no scorecards. The API omits all of those from candidate reads.
 *
 * PC-9: open "choose a time" offers are listed at the top (times in the
 * candidate's own zone); an upcoming round can be rescheduled here, within the
 * employer's allowance — the current time stands until a new one is picked.
 */
export function CandidateInterviewsClient() {
  const q = trpc.candidateListMyInterviews.useQuery();
  const offers = trpc.candidateListMySlotOffers.useQuery();
  const items = q.data?.items ?? [];
  const openOffers = offers.data?.items ?? [];
  const reschedulesRemaining = offers.data?.reschedulesRemaining ?? {};
  const upcoming = items
    .filter((iv) => iv.isUpcoming)
    .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
  const past = items
    .filter((iv) => !iv.isUpcoming)
    .sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));

  return (
    <CandidateShell variant="portal" active="interviews">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">My interviews</h1>
          <p className="text-sm text-neutral-600">Your scheduled rounds and past interviews.</p>
        </header>

        {openOffers.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              Choose a time
            </h2>
            {openOffers.map((o) => (
              <OfferCard key={o.offerId} offer={o} />
            ))}
          </section>
        ) : null}

        {q.isLoading ? (
          <Card className="p-5">
            <p className="text-sm text-neutral-500">Loading…</p>
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              title="No interviews scheduled"
              hint="When a round is scheduled, you'll see it here and can confirm your attendance."
            />
          </Card>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                Upcoming
              </h2>
              {upcoming.length === 0 ? (
                <Card className="p-5">
                  <p className="text-sm text-neutral-500">No upcoming interviews right now.</p>
                </Card>
              ) : (
                upcoming.map((iv) => (
                  <UpcomingCard
                    key={iv.interviewId}
                    interview={iv}
                    reschedulesLeft={reschedulesRemaining[iv.interviewId] ?? 0}
                    hasOpenOffer={openOffers.some((o) => o.replacesInterviewId === iv.interviewId)}
                  />
                ))
              )}
            </section>

            {past.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Past interviews
                </h2>
                {past.map((iv) => (
                  <PastCard key={iv.interviewId} interview={iv} />
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </CandidateShell>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="break-all text-right font-medium text-neutral-900">{value}</dd>
    </div>
  );
}

/** PC-9 — an open offer: pick one of the times. */
function OfferCard({ offer }: { offer: CandidateSlotOfferView }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState(offer.slots);
  const pick = trpc.candidatePickSlot.useMutation({
    onSuccess: () => {
      void utils.candidateListMySlotOffers.invalidate();
      void utils.candidateListMyInterviews.invalidate();
    },
    onError: async (err) => {
      setError(pickRefusalMessage(err.message));
      if (err.message === "slot_taken") {
        const fresh = await utils.candidateGetSlotOffer.fetch({ offerId: offer.offerId });
        setSlots(fresh.slots);
      }
    },
  });
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <p className="text-base font-semibold text-neutral-900">{offer.positionTitle}</p>
        <p className="text-sm text-neutral-500">
          {offer.roundName} · {MODE_LABEL[offer.mode] ?? offer.mode} · {offer.durationMinutes} min
        </p>
        {offer.reason === "panelist_unavailable" ? (
          <p className="mt-1 text-sm text-neutral-700">
            One of your interviewers can no longer make the original time. Please choose a new one.
          </p>
        ) : null}
      </div>
      <SlotPicker
        slots={slots}
        busy={pick.isPending}
        error={error}
        onPick={(slotStart) => {
          setError(null);
          pick.mutate({ offerId: offer.offerId, slotStart });
        }}
      />
    </Card>
  );
}

function UpcomingCard({
  interview,
  reschedulesLeft,
  hasOpenOffer,
}: {
  interview: CandidateInterviewRow;
  reschedulesLeft: number;
  hasOpenOffer: boolean;
}) {
  const utils = trpc.useUtils();
  const [rescheduleNote, setRescheduleNote] = useState<string | null>(null);
  const reschedule = trpc.candidateRequestReschedule.useMutation({
    onSuccess: (res) => {
      setRescheduleNote(
        res.offerId
          ? "New times are listed under “Choose a time” above. Your current time stands until you pick one."
          : res.message,
      );
      void utils.candidateListMySlotOffers.invalidate();
    },
    onError: (err) => setRescheduleNote(err.message),
  });
  const [localConfirmedAt, setLocalConfirmedAt] = useState<string | null>(interview.confirmedAt);
  const [error, setError] = useState<string | null>(null);
  const confirm = trpc.candidateConfirmInterview.useMutation({
    onSuccess: (res) => {
      setLocalConfirmedAt(res.confirmedAt);
      void utils.candidateListMyInterviews.invalidate();
    },
    onError: () => setError("Couldn't confirm just now. Please try again."),
  });

  const confirmed = localConfirmedAt !== null;
  const canConfirm = interview.status === "scheduled" && !confirmed;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-neutral-900">{interview.positionTitle}</p>
          <p className="text-sm text-neutral-500">{interview.roundName}</p>
        </div>
        {confirmed ? (
          <Badge tone="success">Confirmed</Badge>
        ) : interview.status !== "scheduled" ? (
          <Badge tone="neutral">{interview.status}</Badge>
        ) : (
          <Badge tone="warning">Awaiting confirmation</Badge>
        )}
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <InfoRow label="When" value={formatWhen(interview.scheduledStart)} />
        <InfoRow
          label="Format"
          value={`${MODE_LABEL[interview.mode] ?? interview.mode} · ${interview.durationMinutes} min`}
        />
      </dl>

      {interview.meetingUrl ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <p className="text-xs font-medium text-neutral-500">Meeting link</p>
          <a
            href={interview.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block break-all text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            {interview.meetingUrl}
          </a>
          <p className="mt-1.5 text-xs text-neutral-500">
            Use this link to join your interview at the scheduled time.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-error-700">
          {error}
        </p>
      ) : null}

      {rescheduleNote ? <p className="text-sm text-neutral-600">{rescheduleNote}</p> : null}

      {interview.mode !== "ai_async" && interview.status === "scheduled" && !hasOpenOffer ? (
        reschedulesLeft > 0 ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={reschedule.isPending}
              loading={reschedule.isPending}
              onClick={() => {
                setRescheduleNote(null);
                reschedule.mutate({ interviewId: interview.interviewId });
              }}
            >
              Reschedule
            </Button>
            <p className="mt-1 text-xs text-neutral-500">
              {reschedulesLeft} reschedule{reschedulesLeft === 1 ? "" : "s"} left for this round.
            </p>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">
            Need a different time? Please contact your recruiter.
          </p>
        )
      ) : null}

      {canConfirm ? (
        <div>
          <Button
            variant="primary"
            size="sm"
            disabled={confirm.isPending}
            loading={confirm.isPending}
            onClick={() => {
              setError(null);
              confirm.mutate({ interviewId: interview.interviewId });
            }}
          >
            Confirm attendance
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function PastCard({ interview }: { interview: CandidateInterviewRow }) {
  const hasSummary = interview.sharedSummary !== null;
  const hasRec = interview.sharedRecommendation !== null;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-neutral-900">{interview.positionTitle}</p>
          <p className="text-sm text-neutral-500">{interview.roundName}</p>
        </div>
        <Badge tone="neutral">
          {interview.status === "completed" ? "Completed" : interview.status}
        </Badge>
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <InfoRow label="When" value={formatWhen(interview.scheduledStart)} />
      </dl>

      {hasSummary || hasRec ? (
        <div className="flex flex-col gap-2">
          {hasSummary ? (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs font-medium text-neutral-500">Interview summary</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                {interview.sharedSummary}
              </p>
            </div>
          ) : null}
          {hasRec ? (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs font-medium text-neutral-500">Panel recommendation</p>
              <p className="mt-1 text-sm text-neutral-700">{interview.sharedRecommendation}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">No feedback has been shared for this interview.</p>
      )}
    </Card>
  );
}
