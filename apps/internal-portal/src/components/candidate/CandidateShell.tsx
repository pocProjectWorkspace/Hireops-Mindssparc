import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { CandidatePortalChrome } from "./CandidatePortalChrome";
import type { CandidateNavKey } from "./candidate-nav";

/**
 * CandidateShell — chrome for the candidate-facing surfaces. Two modes:
 *
 *   • variant="public" (DEFAULT, DESIGN-04) — the minimal centred-page chrome
 *     for the PUBLIC / pre-auth surfaces (apply, submitted, offer, privacy,
 *     login, activate, interview-confirm): a slim top brand bar, a warm neutral
 *     ground, one centred content column, optional footer. Purely presentational
 *     (no hooks) so it renders inside server components. UNCHANGED — every
 *     existing caller passing {brand,width,footer,children} keeps this exactly.
 *
 *   • variant="portal" (CAND-01) — the AUTHENTICATED routed portal frame: a
 *     DESIGN-05 slate-ink sidebar (candidate nav, neutral tenant brand,
 *     sign-out) around a scrollable content column. Delegates to
 *     CandidatePortalChrome, which resolves the candidate identity + gating.
 *     The routed candidate pages (Dashboard, Applications, Interviews, Settings
 *     — and CAND-02's Profile, Documents, Notifications) wrap their body in
 *     <CandidateShell variant="portal" active="…">.
 *
 * Candidates are an EXTERNAL party: neither mode shows internal nav, and the
 * portal mode surfaces NO scores/feedback (page-level refusals enforce that).
 */
export interface CandidateShellProps {
  /** "public" (default) = top-bar centred page; "portal" = authed sidebar. */
  variant?: "public" | "portal";
  /** Portal mode: which nav item is current (optional — else path-derived). */
  active?: CandidateNavKey;
  /** Public mode: brand shown in the top bar — the employer's name on
   * apply/offer, else the HireOps product wordmark. */
  brand?: string;
  /** Public mode: content max-width. `xl` (default) for forms/offers; `2xl`. */
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
  variant = "public",
  active,
  brand = "HireOps",
  width = "xl",
  footer,
  children,
}: CandidateShellProps) {
  if (variant === "portal") {
    return <CandidatePortalChrome active={active}>{children}</CandidatePortalChrome>;
  }

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
