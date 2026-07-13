import { LoginForm } from "@/components/LoginForm";
import { Card } from "@/components/ui";

// LoginForm uses useSearchParams() for the post-login `?from=` redirect
// destination — Next refuses to prerender pages that read search params
// at build time. force-dynamic makes the page server-render per request.
export const dynamic = "force-dynamic";

/**
 * Public route — exempted from the auth middleware via PUBLIC_PATHS. The first
 * screen anyone sees, so it carries the DESIGN-01 tokens: warm near-white
 * ground, centred white card with a single subtle elevation, the HireOps
 * wordmark, and the refined input/button primitives.
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
          <span className="text-xl font-semibold tracking-tight text-neutral-900">HireOps</span>
        </div>
        <Card className="shadow-2" padded={false}>
          <div className="p-6">
            <h1 className="text-lg font-semibold tracking-tight text-neutral-900">Sign in</h1>
            <p className="mt-1 mb-6 text-sm text-neutral-500">Internal recruiter access only.</p>
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
