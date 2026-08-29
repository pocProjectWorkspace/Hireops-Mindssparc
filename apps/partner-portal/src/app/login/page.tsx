import { LoginForm } from "@/components/LoginForm";
import { PlatformFooter } from "@/components/PlatformFooter";
import { Card } from "@/components/ui";
import { getDeploymentBrand } from "@/lib/brand-env";

// LoginForm reads useSearchParams() for the post-login `?from=` redirect —
// Next refuses to prerender pages that read search params, so render dynamic.
export const dynamic = "force-dynamic";

/**
 * Public route — exempted from the auth middleware via PUBLIC_PATHS. Carries
 * the same DESIGN-01 tokens as the internal portal's login so the two
 * surfaces read as one product: warm near-white ground, centred white card,
 * the HireOps wordmark, refined input/button primitives.
 *
 * BRAND-1: the lockup and the optional "Powered by …" line are DEPLOYMENT-
 * branded, not tenant-branded. This page renders pre-auth — no session, so no
 * tenant to resolve branding from — which is why the env vars
 * (NEXT_PUBLIC_BRAND_LOGO_URL / _BRAND_NAME / _POWERED_BY) are the deliberate
 * mechanism here. Unset → this page renders exactly as it did before.
 */
export default function LoginPage() {
  const brand = getDeploymentBrand();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          {brand.logoUrl ? (
            <>
              {/* Plain <img>, not next/image: the configured URL is arbitrary
                  (usually an off-domain CDN asset), which next/image would
                  reject without a remotePatterns entry per deployment. The
                  muted "Partners" label stays — it is what tells a visitor
                  which of the three sign-in surfaces they are on. */}
              <img
                src={brand.logoUrl}
                alt={brand.name ?? "logo"}
                className="max-h-10 w-auto shrink-0 object-contain"
              />
              <span className="text-xl font-normal tracking-tight text-neutral-500">Partners</span>
            </>
          ) : (
            <>
              <img
                src="/logo/hireops-mark.png"
                alt=""
                aria-hidden
                width={36}
                height={36}
                className="h-9 w-9 shrink-0 object-contain"
              />
              <span className="text-xl font-semibold tracking-tight text-neutral-900">
                HireOps <span className="font-normal text-neutral-500">Partners</span>
              </span>
            </>
          )}
        </div>
        <Card className="shadow-2" padded={false}>
          <div className="p-6">
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
              Partner sign in
            </h1>
            <p className="mt-1 mb-6 text-sm text-neutral-500">
              Sourcing partner access. Kyndryl employees and candidates sign in elsewhere.
            </p>
            <LoginForm />
          </div>
        </Card>
        <p className="mt-6 text-center text-xs text-neutral-400">
          HireOps — hiring operations platform
        </p>
        {brand.poweredBy ? (
          <p className="mt-1.5 text-center text-xs text-neutral-400">{brand.poweredBy}</p>
        ) : null}
        <PlatformFooter centered className="mt-6 border-0 px-0" />
      </div>
    </main>
  );
}
