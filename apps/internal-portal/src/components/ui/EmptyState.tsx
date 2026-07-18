import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * EmptyState — the calm "nothing here" affordance. Optional icon, a title,
 * and an optional hint line; an optional action slot for a primary next step.
 * Centred within whatever container it's dropped into.
 */
export interface EmptyStateProps {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, hint, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}
    >
      {icon ? (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 ring-1 ring-inset ring-neutral-200">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-neutral-900">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-neutral-500">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
