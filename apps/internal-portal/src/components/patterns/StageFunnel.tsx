import { cn } from "@/components/ui/cn";

/**
 * StageFunnel (HRHEAD-01 shared pattern) — labelled horizontal stage bars with
 * the count sitting IN the bar end, over a subdued track, plus an optional
 * warning callout line beneath ("Bottleneck at X — high drop-off"). Brand fill
 * on a quiet neutral track; the label sits above each bar so long stage names
 * never truncate against the count.
 *
 * Reuse contract:
 *   stages     — [{stage, label, count, pct}] where pct is 0–100 of the bar.
 *   bottleneck — optional callout string rendered in an amber note beneath.
 */
export interface StageFunnelStage {
  stage: string;
  label: string;
  count: number;
  pct: number;
}

export function StageFunnel({
  stages,
  bottleneck,
  className,
}: {
  stages: StageFunnelStage[];
  bottleneck?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {stages.map((s) => (
        <div key={s.stage}>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs font-medium text-neutral-600">{s.label}</span>
            <span className="text-xs tabular-nums text-neutral-400">{s.count}</span>
          </div>
          <div className="h-6 w-full overflow-hidden rounded-md bg-neutral-100">
            <div
              className="flex h-full items-center justify-end rounded-md bg-gradient-to-r from-brand-400 to-brand-600 px-2 transition-[width] duration-300"
              style={{ width: `${Math.max(3, Math.min(100, s.pct))}%` }}
            >
              {s.count > 0 ? (
                <span className="text-[11px] font-semibold tabular-nums text-white">{s.count}</span>
              ) : null}
            </div>
          </div>
        </div>
      ))}
      {bottleneck ? (
        <p className="mt-1 rounded-md bg-status-warning-50 px-3 py-2 text-xs font-medium text-status-warning-800">
          {bottleneck}
        </p>
      ) : null}
    </div>
  );
}
