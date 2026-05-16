import { LoginForm } from "@/components/LoginForm";

// LoginForm uses useSearchParams() for the post-login `?from=` redirect
// destination — Next refuses to prerender pages that read search params
// at build time. force-dynamic makes the page server-render per request.
export const dynamic = "force-dynamic";

/**
 * Public route — exempted from the auth middleware via PUBLIC_PATHS.
 * Server-component shell with the form as a child client component.
 */
export default function LoginPage() {
  return (
    <main className="mx-auto mt-16 max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-1">
      <h1 className="mb-2 text-2xl font-semibold text-neutral-900">Sign in to HireOps</h1>
      <p className="mb-6 text-sm text-neutral-600">Internal recruiter access only.</p>
      <LoginForm />
    </main>
  );
}
