"use client";

import type { WorkdayHandoffStatus } from "@hireops/api-types";
import { Badge, Button } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { downloadCsv } from "@/lib/csv";

/**
 * PC-13 — the visible "Workday handoff" step under the offer in the candidate
 * drawer. Workday keeps approvals + offers; HireOps hands the selected
 * candidate back. In the PoC that handoff is a FILE: the status chip says where
 * the record is ("Ready for Workday" → "Sent to Workday (simulated)") and the
 * buttons download the record as CSV / JSON.
 *
 * Renders nothing when there's no live offer (status `none`) or when the
 * caller's role can't see the record (the API's WORKDAY_HANDOFF_ROLES gate
 * returns FORBIDDEN — the panel just stays hidden).
 */
export function WorkdayHandoffPanel({ applicationId }: { applicationId: string }) {
  const handoff = trpc.getWorkdayHandoff.useQuery(
    { applicationId },
    { enabled: !!applicationId, retry: false },
  );
  const data = handoff.data;
  if (!data || data.status === "none") return null;

  const tone = STATUS_TONE[data.status];
  const csv = data.csv;
  const json = data.json;

  return (
    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Workday handoff
        </span>
        <Badge tone={tone}>{data.statusLabel}</Badge>
      </div>
      <p className="mt-1.5 text-xs text-neutral-600">{statusDetail(data)}</p>
      {csv || json ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {csv ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => downloadCsv(`${data.filenameBase}.csv`, csv)}
            >
              Download CSV
            </Button>
          ) : null}
          {json ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => downloadJson(`${data.filenameBase}.json`, json)}
            >
              Download JSON
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_TONE: Record<WorkdayHandoffStatus, BadgeTone> = {
  none: "neutral",
  offer_ready: "neutral",
  ready: "info",
  sent_simulated: "success",
  sent: "success",
  failed: "error",
};

function statusDetail(d: {
  status: WorkdayHandoffStatus;
  queuedAt: string | null;
  sentAt: string | null;
  workdayReference: string | null;
  processedBy: string | null;
}): string {
  switch (d.status) {
    case "offer_ready":
      return "Offer not yet accepted. Approvals happen in Workday; this record is a pre-approval preview.";
    case "ready":
      return d.queuedAt
        ? `Offer accepted. Hire record queued for Workday at ${fmt(d.queuedAt)}.`
        : "Offer accepted. Hire record ready for Workday.";
    case "sent_simulated":
    case "sent": {
      const parts = [`Sent ${d.sentAt ? fmt(d.sentAt) : ""}`.trim()];
      if (d.workdayReference) parts.push(`Workday ref ${d.workdayReference}`);
      if (d.processedBy) parts.push(`by ${d.processedBy}`);
      const suffix =
        d.status === "sent_simulated" ? " Simulated: no live Workday call was made." : "";
      return `${parts.join(" · ")}.${suffix}`;
    }
    case "failed":
      return "The Workday dispatch failed. An admin can see the error in Integration Health.";
    default:
      return "";
  }
}

/** ISO → "2026-11-10 09:30 UTC". */
function fmt(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/** Blob + synthetic anchor click (JSON sibling of downloadCsv). No-ops during SSR. */
function downloadJson(filename: string, value: unknown): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
