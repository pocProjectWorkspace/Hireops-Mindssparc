import { cn } from "./cn";

/**
 * ScoreMeter — the AI score affordance. Turns a 0–100 score into either a
 * compact labelled bar (row/card use) or a ring (drawer hero). The number is
 * the load-bearing element; the track is a quiet 0–100 reference so the figure
 * reads as "82 out of 100", not a bare integer. Brand fill — the score is the
 * one figure worth drawing the eye to. `null` renders a calm "not scored" state.
 */
export interface ScoreMeterProps {
  score: number | null;
  variant?: "bar" | "ring";
  /** Small caps label above/around the meter. */
  label?: string;
  className?: string;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function ScoreMeter({
  score,
  variant = "bar",
  label = "AI score",
  className,
}: ScoreMeterProps) {
  const has = score !== null && Number.isFinite(score);
  const pct = has ? clamp(score) : 0;
  const value = has ? Math.round(pct) : null;

  if (variant === "ring") {
    const r = 26;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - pct / 100);
    return (
      <div className={cn("flex items-center gap-3", className)}>
        <div className="relative h-16 w-16 shrink-0">
          <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
            <circle
              cx="32"
              cy="32"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              className="text-neutral-200"
            />
            {has ? (
              <circle
                cx="32"
                cy="32"
                r={r}
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={c}
                strokeDashoffset={offset}
                className="text-brand-600"
              />
            ) : null}
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums text-neutral-900">
            {value ?? "—"}
          </span>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
          <p className="text-sm text-neutral-500">{has ? "out of 100" : "not scored"}</p>
        </div>
      </div>
    );
  }

  // bar
  return (
    <div
      className={cn("flex items-center gap-2", className)}
      aria-label={`${label} ${value ?? "not scored"}`}
    >
      <span className="w-7 shrink-0 text-right text-sm font-semibold tabular-nums text-neutral-900">
        {value ?? "—"}
      </span>
      <span className="block h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200">
        <span
          className={cn("block h-full rounded-full", has ? "bg-brand-500" : "bg-neutral-300")}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}
