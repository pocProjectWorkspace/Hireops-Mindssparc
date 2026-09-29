import type { ReactNode } from "react";
import { PlatformFooter } from "@/components/nav/PlatformFooter";
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
  /** Public mode: content max-width. `xl` (default) for forms/offers; `2xl`;
   * `5xl` for two-column task surfaces (the AI interview round). */
  width?: "xl" | "2xl" | "5xl";
  /** Public mode: the employer's logo (tenant branding). Falls back to the
   * initial tile when absent or when the image fails to load. */
  logoUrl?: string | null;
  /** Public mode: the employer's brand colour, drawn as a slim accent rule
   * above the top bar. */
  accentColor?: string | null;
  footer?: ReactNode;
  children: ReactNode;
}

function BrandMark({ brand, logoUrl }: { brand: string; logoUrl?: string | null }) {
  const initial = (brand.trim()[0] ?? "H").toUpperCase();
  if (logoUrl) {
    return (
      <div className="flex min-w-0 items-center gap-3">
        <img src={logoUrl} alt={brand} className="h-8 w-auto max-w-[160px] object-contain" />
        <span aria-hidden className="h-6 w-px shrink-0 bg-neutral-200" />
        <span className="truncate text-sm font-semibold tracking-tight text-neutral-900">
          {brand}
        </span>
      </div>
    );
  }
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

const MAX_W: Record<NonNullable<CandidateShellProps["width"]>, string> = {
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "5xl": "max-w-5xl",
};

export function CandidateShell({
  variant = "public",
  active,
  brand = "HireOps",
  width = "xl",
  logoUrl,
  accentColor,
  footer,
  children,
}: CandidateShellProps) {
  if (variant === "portal") {
    return <CandidatePortalChrome active={active}>{children}</CandidatePortalChrome>;
  }

  const maxW = MAX_W[width];
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      {accentColor ? (
        <div aria-hidden className="h-1 w-full" style={{ backgroundColor: accentColor }} />
      ) : null}
      <header className="border-b border-neutral-200 bg-white">
        <div className={cn("mx-auto flex w-full items-center px-4 py-3.5 sm:px-6", maxW)}>
          <BrandMark brand={brand} logoUrl={logoUrl} />
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
      <PlatformFooter className={cn("mx-auto w-full", maxW)} />
    </div>
  );
}
