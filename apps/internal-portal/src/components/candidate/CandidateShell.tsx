import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/**
 * CandidateShell — the minimal centred-page chrome for the public
 * candidate-facing surfaces (apply, submitted, offer, privacy). DESIGN-04.
 *
 * These pages have NO sidebar — candidates never see internal nav — so
 * instead of the recruiter AppShell they get a slim top bar (an employer /
 * product mark), a warm neutral ground, and a single centred content column
 * with generous mobile padding. An optional footer line hosts the privacy
 * link where a surface wants one.
 *
 * Purely presentational (no client hooks, no server-only deps) so it renders
 * inside both server components (apply / submitted / privacy) and the
 * offer-accept client component.
 */
export interface CandidateShellProps {
  /** Brand shown in the top bar — the employer's name on apply/offer, else
   * the HireOps product wordmark. */
  brand?: string;
  /** Content max-width. `xl` (default) for forms/offers; `2xl` for prose. */
  width?: "xl" | "2xl";
  footer?: ReactNode;
  children: ReactNode;
}

function BrandMark({ brand }: { brand: string }) {
  const initial = (brand.trim()[0] ?? "H").toUpperCase();
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
      >
        {initial}
      </span>
      <span className="truncate text-sm font-semibold tracking-tight text-neutral-900">
        {brand}
      </span>
    </div>
  );
}

export function CandidateShell({
  brand = "HireOps",
  width = "xl",
  footer,
  children,
}: CandidateShellProps) {
  const maxW = width === "2xl" ? "max-w-2xl" : "max-w-xl";
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className={cn("mx-auto flex w-full items-center px-4 py-3.5 sm:px-6", maxW)}>
          <BrandMark brand={brand} />
        </div>
      </header>

      <main className={cn("mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-8 sm:px-6", maxW)}>
        {children}
      </main>

      {footer ? (
        <footer className={cn("mx-auto w-full px-4 pb-8 pt-2 text-center sm:px-6", maxW)}>
          {footer}
        </footer>
      ) : null}
    </div>
  );
}
