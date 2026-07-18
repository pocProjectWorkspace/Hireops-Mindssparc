"use client";

import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { CheckIcon, UndoIcon, XIcon } from "./icons";

/**
 * ActionTriad (HRHEAD-01 shared pattern) — the inline approve / send-back /
 * reject row: a filled-positive Approve, an outlined-neutral Send back, and a
 * red-tinted-destructive Reject; compact, icon+label. Send back and reject
 * reveal an inline reason input (both require a reason — matches the server
 * gate) with a confirm/cancel; approve fires immediately.
 *
 * Self-contained interaction so every surface that reuses it (the HR-head
 * dashboard this ticket; later agent/offer approval surfaces) gets identical
 * behaviour. The parent supplies the async handlers and a `pending` flag.
 *
 * Reuse contract:
 *   onApprove()            — called on Approve.
 *   onSendBack(reason)     — called on confirmed Send back (reason non-empty).
 *   onReject(reason)       — called on confirmed Reject (reason non-empty).
 *   pending                — disables all controls while a decision is in flight.
 */
export interface ActionTriadProps {
  onApprove: () => void;
  onSendBack: (reason: string) => void;
  onReject: (reason: string) => void;
  pending?: boolean;
  className?: string;
}

type Arming = "send_back" | "reject" | null;

const btn =
  "inline-flex items-center gap-1.5 rounded-button px-2.5 h-8 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export function ActionTriad({
  onApprove,
  onSendBack,
  onReject,
  pending = false,
  className,
}: ActionTriadProps) {
  const [arming, setArming] = useState<Arming>(null);
  const [reason, setReason] = useState("");

  function confirm() {
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    if (arming === "send_back") onSendBack(trimmed);
    else if (arming === "reject") onReject(trimmed);
    setArming(null);
    setReason("");
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={pending || arming !== null}
          className={cn(
            btn,
            "bg-status-positive-600 text-white shadow-1 hover:bg-status-positive-700",
          )}
        >
          <CheckIcon width={14} height={14} />
          Approve
        </button>
        <button
          type="button"
          onClick={() => {
            setArming((a) => (a === "send_back" ? null : "send_back"));
            setReason("");
          }}
          disabled={pending}
          className={cn(
            btn,
            "border bg-white text-neutral-700 hover:bg-neutral-50",
            arming === "send_back"
              ? "border-brand-400 ring-1 ring-brand-300"
              : "border-neutral-300",
          )}
        >
          <UndoIcon width={14} height={14} />
          Send back
        </button>
        <button
          type="button"
          onClick={() => {
            setArming((a) => (a === "reject" ? null : "reject"));
            setReason("");
          }}
          disabled={pending}
          className={cn(
            btn,
            "border border-status-error-200 bg-status-error-50 text-status-error-700 hover:bg-status-error-100",
            arming === "reject" ? "ring-1 ring-status-error-300" : "",
          )}
        >
          <XIcon width={14} height={14} />
          Reject
        </button>
      </div>
      {arming ? (
        <div className="flex flex-col gap-2">
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              arming === "reject"
                ? "Why is this being rejected? (required — closes the requisition)"
                : "What needs changing before resubmission? (required)"
            }
            disabled={pending}
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={pending || reason.trim().length === 0}
              className={cn(
                btn,
                arming === "reject"
                  ? "bg-status-error-600 text-white hover:bg-status-error-700"
                  : "bg-brand-600 text-white hover:bg-brand-700",
              )}
            >
              {pending ? "Working…" : arming === "reject" ? "Confirm reject" : "Confirm send back"}
            </button>
            <button
              type="button"
              onClick={() => {
                setArming(null);
                setReason("");
              }}
              disabled={pending}
              className={cn(btn, "text-neutral-500 hover:bg-neutral-100")}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
