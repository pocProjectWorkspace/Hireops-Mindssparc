"use client";

import Link from "next/link";
import { useState } from "react";
import {
  PRE_JOINING_STEP_LABELS,
  type EngagementTimelineItem,
  type GetEngagementTimelineOutput,
  type RenegeReason,
} from "@hireops/api-types";
import { Badge, Button, Card } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

const PULSE_LABEL: Record<string, string> = { yes: "Yes, on track", unsure: "Not sure", no: "No" };

function fmt(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Item({
  item,
  onAck,
  busy,
}: {
  item: EngagementTimelineItem;
  onAck: (id: string) => void;
  busy: boolean;
}) {
  switch (item.kind) {
    case "touchpoint":
      return (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-neutral-900">
              {PRE_JOINING_STEP_LABELS[item.stepKey]}
            </span>
            <Badge
              tone={
                item.status === "sent"
                  ? "success"
                  : item.status === "scheduled"
                    ? "info"
                    : "neutral"
              }
            >
              {item.status}
            </Badge>
            {item.carriesPulse ? <Badge tone="accent">check-in</Badge> : null}
          </div>
          {item.detail ? <p className="text-xs text-neutral-500">{item.detail}</p> : null}
        </div>
      );
    case "pulse_response":
      return (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-neutral-900">Check-in answer:</span>
            <Badge
              tone={
                item.onTrack === "yes" ? "success" : item.onTrack === "no" ? "error" : "warning"
              }
            >
              {PULSE_LABEL[item.onTrack]}
            </Badge>
            {item.feeling ? (
              <span className="text-xs text-neutral-500">Feeling {item.feeling}/5</span>
            ) : null}
          </div>
          {item.comment ? (
            <p className="mt-1 whitespace-pre-wrap text-neutral-700">“{item.comment}”</p>
          ) : null}
        </div>
      );
    case "inbound_message":
      return (
        <div>
          <div className="font-medium text-neutral-900">
            Reply from {item.fromEmail}
            {item.subject ? (
              <span className="font-normal text-neutral-500"> · {item.subject}</span>
            ) : null}
          </div>
          {item.bodyText ? (
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 font-sans text-sm text-neutral-700">
              {item.bodyText}
            </pre>
          ) : (
            <p className="text-xs text-neutral-500">No text body.</p>
          )}
        </div>
      );
    case "signal":
      return (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-status-warning-50 px-2 py-0.5 text-xs font-medium text-status-warning-800">
              {item.label}
            </span>
            <span className="text-xs text-neutral-500">
              from {item.source === "inbound_email" ? "a reply" : "a check-in answer"}
            </span>
            {item.status === "open" ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAck(item.id)}>
                Mark as seen
              </Button>
            ) : (
              <Badge>seen</Badge>
            )}
          </div>
          {item.quote ? (
            <p className="mt-1 text-neutral-700">In their words: “{item.quote}”</p>
          ) : null}
        </div>
      );
    case "welcome_guide_viewed":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-neutral-900">Welcome guide viewed</span>
          <Badge tone="info">
            {item.sectionsViewed} section{item.sectionsViewed === 1 ? "" : "s"} read
          </Badge>
          <span className="text-xs text-neutral-500">version {item.guideVersion}</span>
        </div>
      );
    case "renege":
      return (
        <div>
          <span className="font-medium text-status-error-700">Reneged: {item.reasonLabel}</span>
          {item.notes ? <p className="text-neutral-700">{item.notes}</p> : null}
        </div>
      );
  }
}

export function EngagementTimelineClient({
  initial,
  renegeReasons,
}: {
  initial: GetEngagementTimelineOutput;
  renegeReasons: RenegeReason[];
}) {
  const utils = trpc.useUtils();
  const q = trpc.getEngagementTimeline.useQuery(
    { applicationId: initial.applicationId },
    { initialData: initial },
  );
  const t = q.data ?? initial;
  const [msg, setMsg] = useState<string | null>(null);
  const [showRenege, setShowRenege] = useState(false);
  const [reason, setReason] = useState(renegeReasons[0]?.code ?? "");
  const [notes, setNotes] = useState("");

  const refresh = () =>
    Promise.all([
      utils.getEngagementTimeline.invalidate(),
      utils.listJoiningWatchlist.invalidate(),
    ]);
  const ack = trpc.acknowledgeRiskSignal.useMutation({
    onSuccess: () => void refresh(),
    onError: (e) => handleTRPCError(e, { onMessage: setMsg }),
  });
  const renege = trpc.recordRenege.useMutation({
    onSuccess: () => {
      setShowRenege(false);
      void refresh();
    },
    onError: (e) => handleTRPCError(e, { onMessage: setMsg }),
  });

  const canRenege = t.currentStage === "offer_accepted";

  return (
    <PageContainer variant="measure" className="space-y-4">
      <Link href="/joining-watchlist" className="text-sm text-neutral-500 hover:underline">
        ← Joining watchlist
      </Link>
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-neutral-900">{t.candidateName}</div>
          <div className="text-sm text-neutral-600">
            {t.role}
            {t.joiningDate
              ? ` · joining ${new Date(`${t.joiningDate}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
              : ""}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            Journey: {t.journeyStatus}
            {t.journeyStopReason ? ` (${t.journeyStopReason.replace(/_/g, " ")})` : ""}
          </div>
        </div>
        {canRenege ? (
          <Button variant="danger" size="sm" onClick={() => setShowRenege((v) => !v)}>
            Record renege
          </Button>
        ) : null}
      </Card>

      {showRenege ? (
        <Card className="space-y-3">
          <p className="text-sm text-neutral-700">
            The candidate accepted but will not be joining. This marks the offer as reneged, moves
            the application to withdrawn, cancels the pre-boarding onboarding case and stops all
            further engagement emails.
          </p>
          <label className="block text-sm">
            <span className="text-neutral-700">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block h-9 w-full rounded-md border border-neutral-200 px-2"
            >
              {renegeReasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-neutral-700">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
              rows={3}
              className="mt-1 block w-full rounded-md border border-neutral-200 px-2 py-1"
            />
          </label>
          <div className="flex gap-2">
            <Button
              variant="danger"
              disabled={!reason || renege.isPending}
              onClick={() =>
                renege.mutate({
                  applicationId: t.applicationId,
                  reasonCode: reason,
                  notes: notes.trim() ? notes.trim() : null,
                })
              }
            >
              Confirm renege
            </Button>
            <Button variant="ghost" onClick={() => setShowRenege(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {msg ? <p className="text-sm text-status-error-700">{msg}</p> : null}

      <Card>
        {t.items.length === 0 ? (
          <p className="text-sm text-neutral-500">No engagement yet.</p>
        ) : (
          <ol className="space-y-4">
            {t.items.map((item) => (
              <li key={`${item.kind}-${item.id}`} className="flex gap-4 text-sm">
                <div className="w-36 shrink-0 text-xs text-neutral-500">{fmt(item.at)}</div>
                <div className="min-w-0 flex-1">
                  <Item
                    item={item}
                    busy={ack.isPending}
                    onAck={(id) => ack.mutate({ signalId: id })}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </PageContainer>
  );
}
