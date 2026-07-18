import type { ReactNode } from "react";

/**
 * LOCAL page-header title block for the HRHEAD-02 surfaces.
 *
 * ⚠ MERGE FLAG (orchestrator): HRHEAD-01 is building a SHARED PageHeader
 * component concurrently. This is a deliberately-local, minimal equivalent so
 * HRHEAD-02 does not take a dependency on an unmerged file. When both land,
 * replace `<IntelPageHeader …>` with the shared `<PageHeader …>` and delete
 * this file — the props are intentionally a subset (title / subtitle / actions)
 * so the swap is mechanical.
 */
export function IntelPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-neutral-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-neutral-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
