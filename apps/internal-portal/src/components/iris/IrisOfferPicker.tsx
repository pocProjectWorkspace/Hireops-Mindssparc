"use client";

import { useMemo } from "react";
import { trpc } from "@/lib/trpc-client";
import { humanizeSentence } from "@/lib/labels";

/**
 * IrisOfferPicker — the offer picker behind the Iris `request_offer_approval`
 * action. Backed by `listCompDesk` (the comp & offer desk read, gated to
 * COMP_DESK_ROLES — the SAME set that may run this action), so it works for
 * exactly the personas who can send an offer for approval and needs no separate
 * gate.
 *
 * It shows ONLY offers that CAN be routed for approval — a drafted / extended
 * offer that is above the comp band (approvalStatus "required") or was previously
 * rejected and can be re-raised. Already-pending / already-approved offers, and
 * offers within band (no approval needed), are filtered out so the user can't
 * pick something the server would reject. The value is the offer id
 * (`requestOfferApproval`'s input), with a human label (candidate — role —
 * status) for display.
 */

export interface IrisPickedOffer {
  offerId: string;
  label: string;
}

export function IrisOfferPicker({
  value,
  onChange,
  enabled,
}: {
  value: IrisPickedOffer | null;
  onChange: (picked: IrisPickedOffer | null) => void;
  enabled: boolean;
}) {
  const query = trpc.listCompDesk.useQuery({}, { enabled });
  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    // Only offers the server would accept for approval routing: a drafted /
    // extended offer that is above band (required) or was rejected (re-raisable).
    // flatMap narrows offerId to a non-null string for the render below.
    return all.flatMap((r) =>
      r.offerId != null &&
      (r.offerStatus === "drafted" || r.offerStatus === "extended") &&
      (r.approvalStatus === "required" || r.approvalStatus === "rejected")
        ? [
            {
              offerId: r.offerId,
              candidateName: r.candidateName,
              roleTitle: r.roleTitle,
              offerStatus: r.offerStatus,
            },
          ]
        : [],
    );
  }, [query.data]);

  if (value) {
    return (
      <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-medium text-brand-900">{value.label}</p>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="shrink-0 rounded-button px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="block text-sm font-medium text-neutral-800">Offer</p>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="px-3 py-4 text-sm text-neutral-500">Loading offers…</p>
        ) : query.error ? (
          <p className="px-3 py-4 text-sm text-status-error-700">Couldn&apos;t load offers.</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-neutral-500">
            No offers are waiting to be sent for approval.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {rows.map((r) => {
              const label = `${r.candidateName} — ${r.roleTitle} — ${humanizeSentence(
                r.offerStatus ?? "drafted",
              )}`;
              return (
                <li key={r.offerId}>
                  <button
                    type="button"
                    onClick={() => onChange({ offerId: r.offerId, label })}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-neutral-800">
                        {r.candidateName}
                      </span>
                      <span className="block truncate text-xs text-neutral-500">{r.roleTitle}</span>
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {humanizeSentence(r.offerStatus ?? "drafted")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[11px] text-neutral-400">
        Only offers above the comp band that need sign-off are shown.
      </p>
    </div>
  );
}
