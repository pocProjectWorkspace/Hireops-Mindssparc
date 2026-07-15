import { LoginForm } from "@/components/LoginForm";
import { Card } from "@/components/ui";

// LoginForm reads useSearchParams() for the post-login `?from=` redirect —
// Next refuses to prerender pages that read search params, so render dynamic.
export const dynamic = "force-dynamic";

/**
 * Public route — exempted from the auth middleware via PUBLIC_PATHS. Carries
 * the same DESIGN-01 tokens as the internal portal's login so the two
 * surfaces read as one product: warm near-white ground, centred white card,
 * the HireOps wordmark, refined input/button primitives.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-lg font-bold text-white"
          >
            H
          </span>
          <span className="text-xl font-semibold tracking-tight text-neutral-900">
            HireOps <span className="font-normal text-neutral-500">Partners</span>
          </span>
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
      </div>
    </main>
  );
}
