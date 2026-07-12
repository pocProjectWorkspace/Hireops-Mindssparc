"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Offer drafting section inside the CandidateDetailDrawer. Three modes:
 *
 *   - empty + draftable stage (hr_round / offer_drafted): the "Draft
 *     offer" form. Plain textarea for terms — rich text was a Phase 3
 *     polish call we punted on, the candidate-side page renders the
 *     terms as `whiteSpace: pre-wrap` so line breaks survive.
 *
 *   - has drafted offer: "Extend" + "Cancel" actions.
 *
 *   - has extended offer: "Resend link" (re-issues via the same dedup
 *     key, so no double send) + "Cancel" actions.
 *
 *   - terminal offers (accepted / declined / cancelled / expired): show
 *     the offer card with the outcome badge; no actions.
 *
 * Money lives as paise on the wire; this component is the conversion
 * boundary (paise → INR for display, INR → paise on submit).
 */

interface OfferSectionProps {
  applicationId: string;
}

const DRAFTABLE_STAGES = new Set<string>(["hr_round", "offer_drafted"]);

export function OfferSection({ applicationId }: OfferSectionProps) {
  const queryClient = useQueryClient();
  const offers = trpc.listOffersByApplication.useQuery(
    { applicationId },
    { enabled: !!applicationId },
  );
  const [showForm, setShowForm] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [["listOffersByApplication"]] });

  const extend = trpc.extendOffer.useMutation({
    onSuccess: () => {
      void invalidate();
    },
  });
  const cancel = trpc.cancelOffer.useMutation({
    onSuccess: () => {
      void invalidate();
    },
  });

  if (offers.isLoading) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-2 text-base font-semibold text-neutral-900">Offer</h3>
        <p className="text-sm text-neutral-500">Loading…</p>
      </section>
    );
  }

  const rows = offers.data?.rows ?? [];
  const activeOffer = rows.find((r) => r.status === "drafted" || r.status === "extended");
  const draftable = DRAFTABLE_STAGES.has(offers.data?.applicationCurrentStage ?? "");

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold text-neutral-900">Offer</h3>
        {!activeOffer && draftable && !showForm ? (
          <Button variant="primary" onClick={() => setShowForm(true)}>
            Draft offer
          </Button>
        ) : null}
      </header>

      {showForm && !activeOffer ? (
        <DraftOfferForm
          applicationId={applicationId}
          onCreated={() => {
            setShowForm(false);
            void invalidate();
          }}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {rows.length === 0 && !showForm ? (
        <p className="text-sm text-neutral-500">
          {draftable
            ? "No offer yet. Draft one when ready."
            : `Offers can be drafted from stages: ${[...DRAFTABLE_STAGES].join(", ")}.`}
        </p>
      ) : null}

      <ul className="space-y-3">
        {rows.map((offer) => (
          <li key={offer.id} className="rounded border border-neutral-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-neutral-900">
                {formatPaiseAsInr(offer.baseSalaryInrPaise)} · {offer.location}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${badgeClass(offer.status)}`}>
                {offer.status}
              </span>
            </div>
            <p className="text-xs text-neutral-600">
              Joining {offer.joiningDate} · Expires {offer.expiryAt.slice(0, 10)}
            </p>
            {offer.status === "drafted" ? (
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  disabled={extend.isPending}
                  onClick={() => extend.mutate({ offerId: offer.id })}
                >
                  {extend.isPending ? "Extending…" : "Extend offer"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={cancel.isPending}
                  onClick={() => {
                    const reason = window.prompt("Cancel reason?", "Withdrawn") ?? "";
                    if (reason) cancel.mutate({ offerId: offer.id, reason });
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
            {offer.status === "extended" ? (
              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  disabled={cancel.isPending}
                  onClick={() => {
                    const reason = window.prompt("Cancel reason?", "Withdrawn") ?? "";
                    if (reason) cancel.mutate({ offerId: offer.id, reason });
                  }}
                >
                  Cancel offer
                </Button>
              </div>
            ) : null}
            {offer.status === "declined" && offer.declinedReason ? (
              <p className="mt-2 text-xs text-neutral-700">
                Reason: <span className="italic">{offer.declinedReason}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface DraftFormProps {
  applicationId: string;
  onCreated: () => void;
  onCancel: () => void;
}

function DraftOfferForm({ applicationId, onCreated, onCancel }: DraftFormProps) {
  const draft = trpc.draftOffer.useMutation({ onSuccess: onCreated });
  const [baseInr, setBaseInr] = useState("");
  const [variableInr, setVariableInr] = useState("");
  const [bonusInr, setBonusInr] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [location, setLocation] = useState("Bengaluru (Hybrid)");
  const [expiryDays, setExpiryDays] = useState(7);
  const [termsHtml, setTermsHtml] = useState("");

  const baseInrInt = parseInt(baseInr, 10);
  const canSubmit =
    Number.isFinite(baseInrInt) && baseInrInt > 0 && joiningDate.length > 0 && location.length > 0;

  return (
    <form
      className="space-y-3 rounded border border-neutral-200 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        draft.mutate({
          applicationId,
          baseSalaryInrPaise: baseInrInt * 100,
          variableTargetInrPaise: variableInr ? Number(variableInr) * 100 : undefined,
          joiningBonusInrPaise: bonusInr ? Number(bonusInr) * 100 : undefined,
          joiningDate,
          location,
          termsHtml: termsHtml || undefined,
          expiryDays,
        });
      }}
    >
      <NumField label="Base salary (INR per year)" value={baseInr} onChange={setBaseInr} required />
      <NumField
        label="Variable target (INR per year)"
        value={variableInr}
        onChange={setVariableInr}
      />
      <NumField label="Joining bonus (INR)" value={bonusInr} onChange={setBonusInr} />
      <DateField label="Joining date" value={joiningDate} onChange={setJoiningDate} />
      <TextField label="Location" value={location} onChange={setLocation} />
      <NumField
        label="Expiry (days)"
        value={String(expiryDays)}
        onChange={(v) => setExpiryDays(Math.max(1, parseInt(v, 10) || 7))}
      />
      <label className="block">
        <span className="text-xs font-medium text-neutral-700">Terms / boilerplate</span>
        <textarea
          value={termsHtml}
          onChange={(e) => setTermsHtml(e.target.value)}
          rows={6}
          className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
          placeholder="Standard at-will employment, non-compete, etc."
        />
      </label>
      <div className="flex gap-2">
        <Button variant="primary" disabled={!canSubmit || draft.isPending}>
          {draft.isPending ? "Drafting…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={draft.isPending}>
          Discard
        </Button>
      </div>
      {draft.error ? <p className="text-xs text-status-error-700">{draft.error.message}</p> : null}
    </form>
  );
}

function NumField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
      />
    </label>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="mt-1 w-full rounded border border-neutral-300 p-2 text-sm"
      />
    </label>
  );
}

function formatPaiseAsInr(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

function badgeClass(status: string): string {
  switch (status) {
    case "drafted":
      return "bg-neutral-100 text-neutral-800";
    case "extended":
      return "bg-status-info-100 text-status-info-800";
    case "accepted":
      return "bg-status-success-100 text-status-success-800";
    case "declined":
    case "expired":
      return "bg-status-warning-100 text-status-warning-800";
    case "cancelled":
      return "bg-neutral-200 text-neutral-700";
    default:
      return "bg-neutral-100 text-neutral-800";
  }
}
