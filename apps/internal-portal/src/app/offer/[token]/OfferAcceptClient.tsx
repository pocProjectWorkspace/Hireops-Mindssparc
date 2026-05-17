"use client";

import { useEffect, useState } from "react";

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
 * full-width buttons.
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
    return <Centered message="Loading your offer…" />;
  }
  if (state.kind === "error") {
    return <Centered message={state.reason} variant="warning" />;
  }
  if (state.kind === "accepted") {
    return (
      <Centered
        title="Thank you!"
        message="We've recorded your acceptance. Your recruiter will be in touch shortly with onboarding paperwork."
        variant="success"
      />
    );
  }
  if (state.kind === "declined") {
    return (
      <Centered
        title="Got it."
        message="We've recorded your decision. Your recruiter has been notified."
      />
    );
  }

  const offer = state.offer;
  const isTerminal = offer.status !== "extended";

  return (
    <main className="mx-auto min-h-screen max-w-xl bg-neutral-50 px-4 py-8 sm:py-12">
      <header className="mb-6 text-center">
        <p className="text-xs uppercase tracking-wide text-neutral-500">
          {offer.companyName}
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-900">Offer of Employment</h1>
      </header>

      <p className="mb-4 text-base text-neutral-800">Hi {offer.candidateFullName.split(" ")[0]},</p>

      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
        <SummaryRow label="Position" value={offer.positionTitle} />
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
        <SummaryRow label="Expires" value={offer.expiryAt.slice(0, 10)} />
      </section>

      {offer.termsHtml ? (
        <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-700">
            Terms
          </h2>
          <pre className="whitespace-pre-wrap text-sm text-neutral-800">{offer.termsHtml}</pre>
        </section>
      ) : null}

      {isTerminal ? (
        <Centered
          message={`This offer is no longer active (status: ${offer.status}). Please contact your recruiter if you have questions.`}
          variant="warning"
        />
      ) : (
        <section className="space-y-4">
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            By clicking <strong>Accept Offer</strong>, you formally accept this offer of
            employment from {offer.companyName}. By clicking <strong>Decline</strong>, you
            indicate you are not proceeding with this offer.
          </p>
          <label className="block">
            <span className="text-sm font-medium text-neutral-800">
              Confirm your full name as it appears on the offer
            </span>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={offer.candidateFullName}
              className="mt-1 w-full rounded-md border border-neutral-300 p-3 text-base"
            />
          </label>
          {error ? (
            <p className="rounded-md bg-status-error-50 p-3 text-sm text-status-error-800">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy || fullName.trim().length === 0}
              onClick={() => void submitAccept()}
              className="flex-1 rounded-md bg-green-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Submitting…" : "Accept Offer"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowDecline(true)}
              className="flex-1 rounded-md border border-neutral-400 px-4 py-3 text-base font-semibold text-neutral-800 disabled:opacity-60"
            >
              Decline
            </button>
          </div>
        </section>
      )}

      {showDecline ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Decline this offer"
          className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/50 sm:items-center"
        >
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => setShowDecline(false)}
            className="absolute inset-0 cursor-default"
          />
          <div className="relative w-full max-w-md rounded-t-xl bg-white p-5 shadow-2xl sm:rounded-xl">
            <h2 className="mb-2 text-lg font-semibold text-neutral-900">
              Decline this offer?
            </h2>
            <p className="mb-3 text-sm text-neutral-700">
              Optionally let us know why — your recruiter will see this.
            </p>
            <textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              rows={4}
              className="mb-4 w-full rounded-md border border-neutral-300 p-3 text-sm"
              placeholder="Reason (optional)"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowDecline(false)}
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitDecline()}
                className="flex-1 rounded-md bg-status-error-600 px-3 py-2 text-sm font-semibold text-white"
              >
                {busy ? "Submitting…" : "Confirm decline"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-neutral-100 py-2 last:border-0">
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-sm font-medium text-neutral-900">{value}</span>
    </div>
  );
}

function Centered({
  title,
  message,
  variant = "info",
}: {
  title?: string;
  message: string;
  variant?: "info" | "success" | "warning";
}) {
  const bg =
    variant === "success"
      ? "bg-green-50 text-green-900"
      : variant === "warning"
        ? "bg-amber-50 text-amber-900"
        : "bg-white text-neutral-800";
  return (
    <main className="mx-auto min-h-screen max-w-md px-4 py-16">
      <div className={`rounded-lg p-6 text-center shadow-sm ${bg}`}>
        {title ? <h1 className="mb-2 text-xl font-semibold">{title}</h1> : null}
        <p className="text-base">{message}</p>
      </div>
    </main>
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
