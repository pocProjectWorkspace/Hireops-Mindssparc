"use client";

import { useEffect, useState } from "react";
import { Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { SlotPicker, pickRefusalMessage } from "@/components/scheduling/SlotPicker";
import { formatSlot } from "@/components/scheduling/slot-format";

/**
 * PC-9 — the candidate picks an interview time from a private link.
 *
 *   GET  /api/interviews/pick/:token → round summary + the offered times that
 *        are STILL free (re-checked server-side on every read).
 *   POST /api/interviews/pick/:token { slotStart } → books it. If someone else
 *        took that time first, the API answers `slot_taken` with the refreshed
 *        list and the page swaps it in — the candidate just picks again.
 *
 * Times are UTC on the wire and rendered in the candidate's own zone.
 */

interface OfferView {
  ok: true;
  status: "open" | "booked" | "expired" | "cancelled" | "superseded";
  candidateName: string;
  companyName: string;
  positionTitle: string;
  roundName: string;
  durationMinutes: number;
  mode: string;
  reason: string;
  expiresAt: string;
  slots: { start: string; end: string }[];
  bookedSlotStart: string | null;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; offer: OfferView }
  | { kind: "booked"; offer: OfferView; start: string };

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function PickSlotClient({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_BASE}/api/interviews/pick/${token}`)
      .then((r) => r.json())
      .then((body: OfferView | { ok: false; reason: string }) => {
        if (cancelled) return;
        if (!body.ok) {
          setState({ kind: "error", message: pickRefusalMessage(body.reason) });
          return;
        }
        if (body.status === "booked" && body.bookedSlotStart) {
          setState({ kind: "booked", offer: body, start: body.bookedSlotStart });
        } else {
          setState({ kind: "ready", offer: body });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", message: "Couldn't load your interview times." });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function pick(offer: OfferView, slotStart: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/interviews/pick/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slotStart }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        reason?: string;
        scheduledStart?: string;
        slots?: { start: string; end: string }[] | null;
      };
      if (body.ok && body.scheduledStart) {
        setState({ kind: "booked", offer, start: body.scheduledStart });
        return;
      }
      setError(pickRefusalMessage(body.reason ?? "unknown_error"));
      if (body.reason === "slot_taken" && body.slots) {
        setState({ kind: "ready", offer: { ...offer, slots: body.slots } });
      }
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <CandidateShell>
        <EmptyState title="Loading your interview times…" />
      </CandidateShell>
    );
  }
  if (state.kind === "error") {
    return (
      <CandidateShell>
        <EmptyState title="We hit a snag" hint={state.message} />
      </CandidateShell>
    );
  }

  const offer = state.offer;
  return (
    <CandidateShell brand={offer.companyName}>
      <Card className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">
          {state.kind === "booked" ? "You're booked" : `Hi ${offer.candidateName}, pick a time`}
        </h1>
        <p className="text-sm text-neutral-600">
          {offer.roundName} · {offer.positionTitle} at {offer.companyName} ·{" "}
          {MODE_LABEL[offer.mode] ?? offer.mode} · {offer.durationMinutes} minutes
        </p>
        {offer.reason === "panelist_unavailable" && state.kind !== "booked" ? (
          <p className="mt-2 text-sm text-neutral-700">
            One of your interviewers can no longer make the original time. Sorry for the change —
            please choose a new one below.
          </p>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-4">
        {state.kind === "booked" ? (
          <p className="text-sm text-neutral-700">
            Your interview is booked for <strong>{formatSlot(state.start)}</strong> (your time
            zone). A calendar invitation is on its way to your inbox.
          </p>
        ) : offer.status !== "open" ? (
          <p className="text-sm text-neutral-700">
            {pickRefusalMessage(offer.status === "expired" ? "offer_expired" : "offer_closed")}
          </p>
        ) : (
          <>
            <SlotPicker
              slots={offer.slots}
              busy={busy}
              error={error}
              onPick={(s) => void pick(offer, s)}
            />
            <p className="text-xs text-neutral-500">
              This link is private to you and works until {formatSlot(offer.expiresAt)}.
            </p>
          </>
        )}
      </Card>
    </CandidateShell>
  );
}
