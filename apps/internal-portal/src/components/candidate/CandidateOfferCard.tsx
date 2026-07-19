"use client";

import { useState } from "react";
import { Button } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { TRPCClientError } from "@trpc/client";
import {
  BENEFIT_META,
  CONTRACT_TYPE_LABELS,
  type BenefitKey,
  type ContractType,
} from "@hireops/api-types";
import { formatInr, formatDate } from "./candidate-format";

/**
 * CandidateOfferCard (CAND-01) — the in-portal offer, viewed + accepted on the
 * dashboard. Discloses exactly what the public signed-link offer page does:
 * comp, joining date, location, expiry, terms — plus the C10 real terms
 * (contract type / probation / benefits) when the offer row carries them. INR
 * only. Renders nothing until there is an extended-or-accepted offer.
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="break-words text-right font-medium text-neutral-900">{value}</dd>
    </div>
  );
}

export function CandidateOfferCard() {
  const utils = trpc.useUtils();
  const offerQuery = trpc.candidateGetMyOffer.useQuery();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = trpc.candidateAcceptOffer.useMutation({
    onSuccess: () => {
      setConfirming(false);
      void utils.candidateGetMyOffer.invalidate();
      void utils.candidateGetMyOnboarding.invalidate();
      void utils.candidateListMyApplications.invalidate();
    },
    onError: (e) =>
      setError(
        e instanceof TRPCClientError && e.data?.code === "CONFLICT"
          ? "This offer has already been resolved."
          : "Couldn't accept just now. Please try again.",
      ),
  });

  if (offerQuery.isLoading || !offerQuery.data || offerQuery.data.offer === null) {
    return null;
  }
  const offer = offerQuery.data.offer;
  const accepted = offer.status === "accepted";

  // C10 — real terms, rendered only when present on the offer row.
  const contractLabel =
    offer.contractType && offer.contractType in CONTRACT_TYPE_LABELS
      ? CONTRACT_TYPE_LABELS[offer.contractType as ContractType]
      : offer.contractType;
  const benefitLabels = offer.benefits
    .filter((b): b is BenefitKey => b in BENEFIT_META)
    .map((b) => BENEFIT_META[b].label);

  return (
    <Card className="flex flex-col gap-4 border-brand-100 bg-brand-50/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Your offer</p>
          <p className="mt-1 text-lg font-semibold text-neutral-900">{offer.positionTitle}</p>
          <p className="text-sm text-neutral-500">{offer.companyName}</p>
        </div>
        {accepted ? (
          <Badge tone="success">Accepted</Badge>
        ) : (
          <Badge tone="accent">Offer extended</Badge>
        )}
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <Row label="Base salary" value={`${formatInr(offer.baseSalaryInrPaise)} / year`} />
        {offer.variableTargetInrPaise !== null ? (
          <Row
            label="Variable target"
            value={`${formatInr(offer.variableTargetInrPaise)} / year`}
          />
        ) : null}
        {offer.joiningBonusInrPaise !== null ? (
          <Row label="Joining bonus" value={formatInr(offer.joiningBonusInrPaise)} />
        ) : null}
        {contractLabel ? <Row label="Contract type" value={contractLabel} /> : null}
        {offer.probationMonths !== null ? (
          <Row
            label="Probation"
            value={
              offer.probationMonths === 0
                ? "None"
                : `${offer.probationMonths} month${offer.probationMonths === 1 ? "" : "s"}`
            }
          />
        ) : null}
        <Row label="Joining date" value={formatDate(offer.joiningDate)} />
        <Row label="Location" value={offer.location} />
        {!accepted ? <Row label="Respond by" value={formatDate(offer.expiryAt)} /> : null}
      </dl>

      {benefitLabels.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-neutral-500">Benefits</p>
          <div className="flex flex-wrap gap-1.5">
            {benefitLabels.map((label) => (
              <span
                key={label}
                className="rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-xs font-medium text-neutral-700"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {offer.termsHtml ? (
        <p className="whitespace-pre-wrap rounded-md bg-white/70 p-3 text-sm text-neutral-600">
          {offer.termsHtml}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-error-700">
          {error}
        </p>
      ) : null}

      {accepted ? (
        <p className="text-sm text-status-success-700">
          You accepted this offer. We&rsquo;ll be in touch about onboarding — any documents to share
          appear under Documents.
        </p>
      ) : confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-700">
            Accept this offer to join {offer.companyName} on {formatDate(offer.joiningDate)}?
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={accept.isPending}
              loading={accept.isPending}
              onClick={() => {
                setError(null);
                accept.mutate({ offerId: offer.offerId });
              }}
            >
              Confirm acceptance
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={accept.isPending}
              onClick={() => setConfirming(false)}
            >
              Not yet
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="primary" size="sm" onClick={() => setConfirming(true)}>
            Accept offer
          </Button>
        </div>
      )}
    </Card>
  );
}
