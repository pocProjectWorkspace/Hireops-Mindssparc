import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * PageHeader (HRHEAD-01 shared pattern) — the persona-surface page title block.
 * A big title, a grey one-line subtitle, and a right slot for an action button
 * or filter tabs. Applied to the HR-head dashboard + approvals page this
 * ticket; later persona passes roll it out across their surfaces.
 *
 * Reuse contract:
 *   title     — the H1 text.
 *   subtitle  — optional one-line grey caption under the title.
 *   right     — optional right-aligned slot (button, filter tabs, chip row).
 *   className  — wraps the header; callers set page padding.
 */
export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, right, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-neutral-500">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}
