"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, Input } from "@hireops/ui";
import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";

/**
 * Single-page candidate offer accept / decline flow.
 *
 * Flow:
 *   1. GET /api/offers/preview/:token to render the summary card +
 *      know the candidate name we expect for the confirmation match
 *   2. Candidate types their full name and clicks Accept (or opens
 *      the decline modal and submits a reason)
 *   3. POST /api/offers/accept/:token (or /decline) — the api returns
 *      ok=true and we render a "Thank you" page
 *
 * Errors surface as inline banners. Mobile-first layout: single column,
 * full-width buttons. DESIGN-04 restyle is visual only — the fetch calls,
 * state machine, and name-match enforcement are unchanged.
 */

interface OfferPreview {
  offerId: string;
  status: string;
  candidateFullName: string;
  candidateEmail: string;
  companyName: string;
  positionTitle: string;
  baseSalaryInrPaise: number;
  variableTargetInrPaise: number | null;
  joiningBonusInrPaise: number | null;
  joiningDate: string;
  location: string;
  expiryAt: string;
  termsHtml: string | null;
  // HROPS-02 offer terms — optional so pre-HROPS-02 API responses parse fine.
  contractType?: string | null;
  probationMonths?: number | null;
  benefits?: string[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; offer: OfferPreview }
  | { kind: "accepted" }
  | { kind: "declined" };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

export function OfferAcceptClient({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDecline, setShowDecline] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_BASE}/api/offers/preview/${token}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (!body.ok) {
          setState({ kind: "error", reason: friendlyReason(body.reason) });
        } else {
          setState({ kind: "ready", offer: body as OfferPreview });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", reason: "Couldn't load the offer." });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submitAccept() {
    setBusy(true);
    setError(null);
    const res = await fetch(`${API_BASE}/api/offers/accept/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName }),
    });
    const body = (await res.json()) as { ok?: boolean; reason?: string };
    setBusy(false);
    if (body.ok) {
      setState({ kind: "accepted" });
    } else {
      setError(friendlyReason(body.reason ?? "unknown_error"));
    }
  }

  async function submitDecline() {
    setBusy(true);
    setError(null);
    const res = await fetch(`${API_BASE}/api/offers/decline/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: declineReason || undefined }),
    });
    const body = (await res.json()) as { ok?: boolean; reason?: string };
    setBusy(false);
    if (body.ok) {
      setState({ kind: "declined" });
    } else {
      setError(friendlyReason(body.reason ?? "unknown_error"));
    }
  }

  if (state.kind === "loading") {
    return (
      <StatusScreen>
        <EmptyState title="Loading your offer…" />
      </StatusScreen>
    );
  }
  if (state.kind === "error") {
    return (
      <StatusScreen>
        <EmptyState icon={<WarningIcon />} title="We hit a snag" hint={state.reason} />
      </StatusScreen>
    );
  }
  if (state.kind === "accepted") {
    return (
      <StatusScreen>
        <EmptyState
          icon={<CheckIcon />}
          title="Offer accepted"
          hint="We've recorded your acceptance. Your recruiter will be in touch shortly with onboarding paperwork."
        />
      </StatusScreen>
    );
  }
  if (state.kind === "declined") {
    return (
      <StatusScreen>
        <EmptyState
          title="Got it."
          hint="We've recorded your decision. Your recruiter has been notified."
        />
      </StatusScreen>
    );
  }

  const offer = state.offer;
  const isTerminal = offer.status !== "extended";

  return (
    <CandidateShell brand={offer.companyName}>
      <header className="flex flex-col items-center gap-2 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {offer.companyName}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Offer of Employment
        </h1>
        <p className="text-sm text-neutral-600">
          Hi {offer.candidateFullName.split(" ")[0]}, please review the details below.
        </p>
      </header>

      {/* Formal, document-like summary. */}
      <Card className="p-0">
        <div className="border-b border-neutral-100 px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Position</p>
          <p className="mt-0.5 text-base font-semibold text-neutral-900">{offer.positionTitle}</p>
        </div>
        <dl className="px-5 py-1">
          <SummaryRow label="Joining date" value={offer.joiningDate} />
          <SummaryRow label="Location" value={offer.location} />
          <SummaryRow
            label="Base salary"
            value={`${formatPaiseAsInr(offer.baseSalaryInrPaise)} per year`}
          />
          {offer.variableTargetInrPaise !== null ? (
            <SummaryRow
              label="Variable target"
              value={`${formatPaiseAsInr(offer.variableTargetInrPaise)} per year`}
            />
          ) : null}
          {offer.joiningBonusInrPaise !== null ? (
            <SummaryRow
              label="Joining bonus"
              value={formatPaiseAsInr(offer.joiningBonusInrPaise)}
            />
          ) : null}
          {offer.contractType ? (
            <SummaryRow label="Contract type" value={humanizeTerm(offer.contractType)} />
          ) : null}
          {offer.probationMonths != null ? (
            <SummaryRow
              label="Probation"
              value={`${offer.probationMonths} month${offer.probationMonths === 1 ? "" : "s"}`}
            />
          ) : null}
          <SummaryRow label="Offer expires" value={offer.expiryAt.slice(0, 10)} />
        </dl>
      </Card>

      {offer.benefits && offer.benefits.length > 0 ? (
        <Card>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Benefits
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {offer.benefits.map((b) => (
              <li
                key={b}
                className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-700"
              >
                {humanizeTerm(b)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {offer.termsHtml ? (
        <Card>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Terms
          </h2>
          <pre className="whitespace-pre-wrap font-ui text-sm text-neutral-800">
            {offer.termsHtml}
          </pre>
        </Card>
      ) : null}

      {isTerminal ? (
        <Card className="flex flex-col items-center gap-3 py-8 text-center">
          <Badge tone="warning">Status: {offer.status}</Badge>
          <p className="max-w-sm text-sm text-neutral-600">
            This offer is no longer active. Please contact your recruiter if you have questions.
          </p>
        </Card>
      ) : (
        <Card className="flex flex-col gap-4 border-brand-200 bg-brand-50/40">
          <p className="text-sm text-neutral-700">
            By clicking <strong>Accept Offer</strong>, you formally accept this offer of employment
            from {offer.companyName}. By clicking <strong>Decline</strong>, you indicate you are not
            proceeding with this offer.
          </p>
          <Input
            label="Confirm your full name as it appears on the offer"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={offer.candidateFullName}
            autoComplete="name"
          />
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800"
            >
              {error}
            </div>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              variant="primary"
              size="lg"
              fullWidth
              disabled={busy || fullName.trim().length === 0}
              loading={busy}
              onClick={() => void submitAccept()}
            >
              Accept Offer
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              fullWidth
              disabled={busy}
              onClick={() => setShowDecline(true)}
            >
              Decline
            </Button>
          </div>
        </Card>
      )}

      {showDecline ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Decline this offer"
          className="fixed inset-0 z-modal flex items-end justify-center bg-neutral-900/50 sm:items-center"
        >
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => setShowDecline(false)}
            className="absolute inset-0 cursor-default"
          />
          <div className="relative w-full max-w-md rounded-t-lg border border-neutral-200 bg-white p-5 shadow-2 sm:rounded-lg">
            <h2 className="mb-2 text-lg font-semibold text-neutral-900">Decline this offer?</h2>
            <p className="mb-3 text-sm text-neutral-600">
              Optionally let us know why — your recruiter will see this.
            </p>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              rows={4}
              className="mb-4 w-full rounded-md border border-neutral-300 p-3 text-sm text-neutral-900 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-brand-500"
              placeholder="Reason (optional)"
            />
            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                fullWidth
                onClick={() => setShowDecline(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                fullWidth
                disabled={busy}
                loading={busy}
                onClick={() => void submitDecline()}
              >
                Confirm decline
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </CandidateShell>
  );
}

function StatusScreen({ children }: { children: ReactNode }) {
  return (
    <CandidateShell>
      <Card className="my-auto">{children}</Card>
    </CandidateShell>
  );
}

/** "full_time" → "Full time", "health_insurance" → "Health insurance". */
function humanizeTerm(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-neutral-100 py-2.5 last:border-0">
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="text-right text-sm font-medium text-neutral-900">{value}</dd>
    </div>
  );
}

function CheckIcon() {
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-positive-50 text-status-positive-600">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

function WarningIcon() {
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-warning-50 text-status-warning-600">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
  );
}

function formatPaiseAsInr(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

function friendlyReason(code: string): string {
  switch (code) {
    case "expired":
      return "This offer link has expired. Please contact your recruiter.";
    case "bad_signature":
    case "malformed":
      return "This link is invalid. Please contact your recruiter.";
    case "offer_not_found":
      return "We couldn't find this offer. Please contact your recruiter.";
    case "already_redeemed":
    case "already_resolved":
      return "This offer has already been responded to.";
    case "name_mismatch":
      return "The name you entered doesn't match our records. Please check spelling and try again.";
    case "wrong_action":
      return "This link is for a different action. Please contact your recruiter.";
    case "invalid_body":
      return "Please complete all required fields.";
    default:
      return `Something went wrong (${code}). Please try again or contact your recruiter.`;
  }
}
