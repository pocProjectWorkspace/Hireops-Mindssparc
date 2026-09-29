"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AiInterviewIntegrityEventType } from "@hireops/api-types";

/**
 * AI-INT-1 — the candidate page's integrity log.
 *
 * While the round is RUNNING, notes when the candidate leaves or re-enters
 * full screen, hides or re-shows the tab, and moves focus to another window —
 * and how long they were gone. THAT IS ALL. Nothing about the screen, the
 * device, the clipboard or the camera is read, and the disclosure (v2) says
 * so. The events are signals for a human reviewer and nothing reads them
 * automatically.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEVER IN THE WAY OF ANSWERING
 * ─────────────────────────────────────────────────────────────────────────
 * Every post is fire-and-forget and every error is swallowed. A candidate on
 * a flaky connection, a browser that refuses full screen (iOS Safari does),
 * an API that refuses the batch — none of it may cost them an answer. The log
 * is an aid to a reviewer, not a gate on the round.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE TAB SWITCH, ONE EVENT
 * ─────────────────────────────────────────────────────────────────────────
 * Switching tabs fires BOTH `visibilitychange` and window `blur`, in an order
 * that varies by browser. Counting both would double every switch, so
 * visibility wins: a blur is only recorded as `window_blur` if, a beat later,
 * the document is still visible — i.e. focus went to another window, an OS
 * dialog or devtools while this page stayed on screen. The matching focus is
 * only recorded if its blur was.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIVERY
 * ─────────────────────────────────────────────────────────────────────────
 * Buffered and flushed ~1.5s after the last event, immediately on a RETURN
 * event (so a reviewer sees "away 41s" even if the tab is then closed), and
 * with `navigator.sendBeacon` on pagehide. Sent as text/plain so the request
 * is a CORS "simple" request with no preflight — the only way a beacon can
 * reach the API on another origin; the API parses the body as JSON anyway.
 */

const FLUSH_DEBOUNCE_MS = 1_500;
/** How long to wait after a blur to see whether the tab went hidden too. */
const BLUR_SETTLE_MS = 250;
/** Mirrors the API's per-call limit; a bigger buffer is sent in slices. */
const BATCH_MAX = 50;

interface PendingEvent {
  type: AiInterviewIntegrityEventType;
  clientAt: string;
  awayMs: number | null;
  questionKey: string | null;
}

export interface IntegrityLog {
  /** The Fullscreen API exists and the document is allowed to use it. */
  fullscreenSupported: boolean;
  isFullscreen: boolean;
  /** Ask for full screen. Must be called from a user gesture; never throws. */
  requestFullscreen: () => void;
  /** Send whatever is buffered. Resolves when sent (or failed) — never rejects. */
  flush: () => Promise<void>;
}

/** Ask the browser for full screen, silently accepting a refusal. */
export function requestFullscreenQuietly(): void {
  try {
    const el = document.documentElement;
    if (typeof el.requestFullscreen !== "function") return;
    void el.requestFullscreen().catch(() => {
      // Refused (Safari/iOS, an iframe without allowfullscreen, no gesture).
      // The round works without it; the banner offers another go.
    });
  } catch {
    // Some engines throw synchronously instead of rejecting.
  }
}

export function useIntegrityLog({
  endpoint,
  active,
  questionKey,
}: {
  /** Full URL of POST /api/interviews/ai/:token/integrity. */
  endpoint: string;
  /** True while the round is in progress. Listeners exist only while true. */
  active: boolean;
  /** The question on screen, stamped onto each event. */
  questionKey: string | null;
}): IntegrityLog {
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const bufferRef = useRef<PendingEvent[]>([]);
  const timerRef = useRef<number | null>(null);
  const questionKeyRef = useRef<string | null>(questionKey);
  useEffect(() => {
    questionKeyRef.current = questionKey;
  }, [questionKey]);

  const send = useCallback(
    async (events: PendingEvent[], beacon: boolean): Promise<void> => {
      for (let i = 0; i < events.length; i += BATCH_MAX) {
        const body = JSON.stringify({ events: events.slice(i, i + BATCH_MAX) });
        try {
          if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
            const queued = navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }));
            if (queued) continue;
          }
          await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body,
            keepalive: true,
          });
        } catch {
          // Fire-and-forget: a lost integrity note never costs an answer.
        }
      }
    },
    [endpoint],
  );

  const flushNow = useCallback(
    async (beacon = false): Promise<void> => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const events = bufferRef.current;
      if (events.length === 0) return;
      bufferRef.current = [];
      await send(events, beacon);
    },
    [send],
  );

  const flush = useCallback(() => flushNow(false), [flushNow]);

  useEffect(() => {
    const supported =
      typeof document !== "undefined" &&
      document.fullscreenEnabled === true &&
      typeof document.documentElement.requestFullscreen === "function";
    setFullscreenSupported(supported);
    setIsFullscreen(typeof document !== "undefined" && !!document.fullscreenElement);
  }, []);

  useEffect(() => {
    if (!active) return;

    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    let blurAt: number | null = null;
    let blurRecorded = false;
    let blurTimer: number | null = null;
    let fullscreenExitAt: number | null = null;

    setIsFullscreen(!!document.fullscreenElement);

    function push(type: AiInterviewIntegrityEventType, awayMs: number | null = null) {
      bufferRef.current.push({
        type,
        clientAt: new Date().toISOString(),
        awayMs: awayMs === null ? null : Math.max(0, Math.round(awayMs)),
        questionKey: questionKeyRef.current,
      });
      const isReturn =
        type === "tab_visible" || type === "window_focus" || type === "fullscreen_enter";
      if (isReturn) {
        void flushNow(false);
        return;
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flushNow(false), FLUSH_DEBOUNCE_MS);
    }

    function onFullscreenChange() {
      const inFullscreen = !!document.fullscreenElement;
      setIsFullscreen(inFullscreen);
      if (!inFullscreen) {
        fullscreenExitAt = Date.now();
        push("fullscreen_exit");
      } else {
        push("fullscreen_enter", fullscreenExitAt === null ? null : Date.now() - fullscreenExitAt);
        fullscreenExitAt = null;
      }
    }

    function onVisibilityChange() {
      if (document.hidden) {
        hiddenAt = Date.now();
        push("tab_hidden");
        // The tab may never come back (closed, phone locked): send now while
        // the page can still make a request.
        void flushNow(true);
      } else {
        push("tab_visible", hiddenAt === null ? null : Date.now() - hiddenAt);
        hiddenAt = null;
      }
    }

    function onBlur() {
      blurAt = Date.now();
      blurRecorded = false;
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(() => {
        blurTimer = null;
        // Still visible → focus went to another window, not another tab.
        if (!document.hidden && blurAt !== null) {
          blurRecorded = true;
          push("window_blur");
        }
      }, BLUR_SETTLE_MS);
    }

    function onFocus() {
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (blurRecorded && blurAt !== null) push("window_focus", Date.now() - blurAt);
      blurAt = null;
      blurRecorded = false;
    }

    function onPageHide() {
      void flushNow(true);
    }

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      // Whatever is still buffered goes now; after a submit it is refused by
      // the API, which is harmless.
      void flushNow(false);
    };
  }, [active, flushNow]);

  return {
    fullscreenSupported,
    isFullscreen,
    requestFullscreen: requestFullscreenQuietly,
    flush,
  };
}
