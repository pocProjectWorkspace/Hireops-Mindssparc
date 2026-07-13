"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Reverse-mutation undo: the action commits immediately, the toast is
 * just the user-facing affordance to ISSUE the reverse mutation within
 * a 5-second window. After expiry the toast disappears; nothing else
 * happens (the original mutation already landed).
 *
 * One toast in flight at a time. A second action replaces the toast
 * immediately (and silently abandons the previous toast's countdown
 * — no commit/dismiss noise because the previous action already
 * committed when it fired).
 *
 * We use React Context here, not Zustand. The toast is the only piece
 * of global UI state in Module 1b; introducing a state-management lib
 * for one shape is overkill. If a second global shape lands (e.g. a
 * keyboard shortcut palette, a side-rail) revisit.
 */

const TOAST_DURATION_MS = 5_000;

export interface UndoToastState {
  /** Free-form label rendered in the toast body. */
  message: string;
  /** Application this toast is undoing — surfaced for tests + handlers. */
  applicationId: string;
  /** The transition id the undo will reverse — needed by revertApplicationStage. */
  transitionId: string;
  /** Display name for the announce/log message. */
  candidateName: string;
}

export interface UndoToastApi {
  /** Current toast (null when nothing is in flight). */
  toast: (UndoToastState & { expiresAt: number }) | null;
  /** Start (or replace) a toast. */
  show: (state: UndoToastState) => void;
  /** Dismiss the current toast manually (e.g. on Undo click). */
  dismiss: () => void;
  /**
   * Register the handler invoked when the user clicks Undo. The handler
   * receives the toast snapshot; it's responsible for firing the
   * reverse mutation. Returning a Promise lets the toast keep state
   * accurate while the mutation is in flight (we just dismiss eagerly
   * here — the optimistic-revert reconciliation lives in the caller).
   */
  onUndo: (cb: (state: UndoToastState) => void | Promise<void>) => () => void;
  /**
   * Fires when the toast expires without an undo click. Callers can
   * use this to release optimistic state (or just clean up listeners).
   */
  onExpire: (cb: (state: UndoToastState) => void) => () => void;
}

const UndoToastContext = createContext<UndoToastApi | null>(null);

export function UndoToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(UndoToastState & { expiresAt: number }) | null>(null);
  const undoHandlers = useRef(new Set<(state: UndoToastState) => void | Promise<void>>());
  const expireHandlers = useRef(new Set<(state: UndoToastState) => void>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = useCallback((state: UndoToastState) => {
    clearTimer();
    const expiresAt = Date.now() + TOAST_DURATION_MS;
    setToast({ ...state, expiresAt });
    timerRef.current = setTimeout(() => {
      expireHandlers.current.forEach((cb) => cb(state));
      setToast((current) => (current && current.expiresAt === expiresAt ? null : current));
    }, TOAST_DURATION_MS);
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, []);

  const onUndo = useCallback((cb: (state: UndoToastState) => void | Promise<void>) => {
    undoHandlers.current.add(cb);
    return () => {
      undoHandlers.current.delete(cb);
    };
  }, []);

  const onExpire = useCallback((cb: (state: UndoToastState) => void) => {
    expireHandlers.current.add(cb);
    return () => {
      expireHandlers.current.delete(cb);
    };
  }, []);

  // Internal: invoked when the toast's button is clicked.
  const handleUndoClick = useCallback(() => {
    if (!toast) return;
    const snapshot: UndoToastState = {
      message: toast.message,
      applicationId: toast.applicationId,
      transitionId: toast.transitionId,
      candidateName: toast.candidateName,
    };
    undoHandlers.current.forEach((cb) => {
      const result = cb(snapshot);
      if (result && typeof result === "object" && "catch" in result) {
        (result as Promise<void>).catch((err) => {
          console.error("[UndoToast] undo handler threw", err);
        });
      }
    });
    dismiss();
  }, [toast, dismiss]);

  useEffect(() => clearTimer, []);

  const api: UndoToastApi = { toast, show, dismiss, onUndo, onExpire };

  return (
    <UndoToastContext.Provider value={api}>
      {children}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 z-toast flex -translate-x-1/2 items-center gap-3 rounded-md border border-neutral-300 bg-white px-4 py-3 shadow-2"
        >
          <span className="text-sm text-neutral-800">{toast.message}</span>
          <button
            type="button"
            onClick={handleUndoClick}
            className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium uppercase tracking-wider text-white transition-colors hover:bg-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            Undo
          </button>
          <CountdownBar expiresAt={toast.expiresAt} durationMs={TOAST_DURATION_MS} />
        </div>
      )}
    </UndoToastContext.Provider>
  );
}

export function useUndoToast(): UndoToastApi {
  const ctx = useContext(UndoToastContext);
  if (!ctx) {
    throw new Error("useUndoToast must be called inside <UndoToastProvider>");
  }
  return ctx;
}

/**
 * 5s shrinking bar. Repaints via requestAnimationFrame so the bar
 * stays visually smooth even under React Query refetch churn.
 */
function CountdownBar({ expiresAt, durationMs }: { expiresAt: number; durationMs: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setRemaining(Math.max(0, expiresAt - Date.now()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [expiresAt]);

  const pct = Math.max(0, Math.min(100, (remaining / durationMs) * 100));
  return (
    <span aria-hidden className="block h-1 w-16 overflow-hidden rounded-full bg-neutral-200">
      <span className="block h-full bg-neutral-900" style={{ width: `${pct}%` }} />
    </span>
  );
}
