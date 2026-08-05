"use client";

import { useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Selection state for the approval queue, mirrored into `?approvalId=` — same
 * URL-as-state intent as the triage drawer (use-drawer-routing). This makes a
 * selected approval deep-linkable and survives a refresh, which matters for the
 * demo (present the queue, click a candidate, the URL is shareable).
 *
 * The selection RENDERS from local state, not from the search param. It used to
 * read straight back out of useSearchParams() after a router.replace, and
 * /approvals is force-dynamic: every selection was a full server round-trip
 * (requireAuth + listPendingApprovals + a fresh RSC payload) before the tapped
 * card could even show as selected. On a phone that reads as a dead tap, so the
 * approver taps again — the "approval actions need several taps" report. Local
 * state lands on the next frame; the URL is then updated with the native
 * history API, which is free and needs no server work.
 *
 * The param is read once, at mount, to honour a deep link. Nothing reads it
 * afterwards, so this does not depend on Next's history-API integration.
 * replaceState (not pushState) keeps the previous behaviour of not pushing a
 * history entry per selection.
 */
export function useApprovalSelection() {
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    searchParams.get("approvalId"),
  );

  const write = useCallback((id: string | null) => {
    setSelectedId(id);
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("approvalId", id);
    else params.delete("approvalId");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, []);

  const select = useCallback((id: string) => write(id), [write]);
  const clear = useCallback(() => write(null), [write]);

  return { selectedId, select, clear };
}
