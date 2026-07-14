"use client";

import { useEffect } from "react";

/**
 * Per-route error boundary for a case-detail server-component failure
 * (e.g. a getOnboardingCaseDetail rejection). A genuinely missing case
 * renders the framework 404 (page.tsx calls notFound()); this covers the
 * unexpected-error path. Reset re-renders the segment.
 */
export default function OnboardingCaseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[onboarding case error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load this onboarding case
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching the case. Try again, or go back to the list.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Try again
        </button>
        <a
          href="/onboarding"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          All cases
        </a>
      </div>
    </main>
  );
}
