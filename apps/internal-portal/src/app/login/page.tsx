import { LoginForm } from "@/components/LoginForm";
import { BrandGlyph } from "@/components/nav/BrandGlyph";
import { getDeploymentBrand } from "@/lib/brand-env";

// LoginForm uses useSearchParams() for the post-login `?from=` redirect
// destination — Next refuses to prerender pages that read search params
// at build time. force-dynamic makes the page server-render per request.
export const dynamic = "force-dynamic";

/**
 * Public route — exempted from the auth middleware via PUBLIC_PATHS. The first
 * screen anyone sees, so it carries the brand: a split layout with a slate-ink
 * DESIGN-05 panel (the same sidebar palette as the app chrome) stating the
 * HireOps positioning, and a clean sign-in column on the right. The brand panel
 * is desktop-only; on small screens the wordmark sits above the form. Copy is
 * honest — real capabilities, no invented testimonial.
 *
 * BRAND-1: the lockup above the form and the optional "Powered by …" line are
 * DEPLOYMENT-branded, not tenant-branded. This page renders pre-auth, so there
 * is no session and therefore no tenant to resolve branding from — env vars
 * (NEXT_PUBLIC_BRAND_LOGO_URL / _BRAND_NAME / _POWERED_BY) are the deliberate
 * mechanism here. Unset → this page renders exactly as it did before.
 */
export default function LoginPage() {
  const brand = getDeploymentBrand();

  return (
    <main className="flex min-h-screen bg-white">
      {/* ── Left: branded panel (desktop only) ────────────────────────────── */}
      <aside className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-sidebar-brand p-12 lg:flex xl:w-[55%]">
        {/* soft indigo glows for depth */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-sidebar-accent/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl"
        />

        {/* The colour lockup does NOT go here — its "Hire" is near-black navy
            and sinks into this panel. The lockup sits on the white sign-in
            column instead; this side carries the monochrome glyph, which takes
            its colour from the surface and stays legible. */}
        <div className="relative flex items-center gap-2.5">
          <BrandGlyph size={34} className="shrink-0 text-white" />
          <span className="text-xl font-semibold tracking-tight text-white">HireOps</span>
        </div>

        {/* positioning */}
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">
            Hiring operations, run end to end.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-sidebar-fg-muted">
            Sourcing, triage, interviews, approvals, offers, and onboarding, one governed platform,
            with every decision audited.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-sidebar-fg">
            {[
              "Real AI screening with explainable scores",
              "Configurable approvals, SLAs, and governance",
              "Tenant-isolated and audit-logged by default",
            ].map((point) => (
              <li key={point} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 flex-none rounded-full bg-sidebar-accent"
                />
                {point}
              </li>
            ))}
          </ul>
        </div>

        {/* footer */}
        <p className="relative text-xs text-sidebar-fg-muted">
          HireOps, hiring operations platform
        </p>
      </aside>

      {/* ── Right: sign-in ─────────────────────────────────────────────────── */}
      <section className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-1/2 xl:w-[45%]">
        <div className="w-full max-w-sm">
          {/* The colour lockup lives here, above the form, at every breakpoint.
              This column is white, which is the ground the artwork was drawn
              for — the dark brand panel swallowed it. */}
          <div className="mb-9 flex justify-center">
            {brand.logoUrl ? (
              // Plain <img>, not next/image: the configured URL is arbitrary
              // (often an off-domain CDN asset), which next/image would reject
              // without a remotePatterns entry per deployment.
              <img src={brand.logoUrl} alt={brand.name ?? "logo"} className="max-h-10 w-auto" />
            ) : (
              <img
                src="/logo/hireops-lockup.png"
                alt="HireOps"
                width={240}
                height={97}
                className="h-14 w-auto"
              />
            )}
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Sign in</h1>
          <p className="mt-1.5 mb-8 text-sm text-neutral-500">Internal recruiter access only.</p>

          <LoginForm />

          {brand.poweredBy ? (
            <p className="mt-10 text-xs text-neutral-400">{brand.poweredBy}</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
