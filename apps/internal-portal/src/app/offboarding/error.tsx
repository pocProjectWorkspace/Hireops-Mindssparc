"use client";

import { useEffect } from "react";

/**
 * Per-route error boundary for /offboarding server-component failures
 * (e.g. a listOffboardingCases rejection). Reset re-renders the segment.
 */
export default function OffboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[offboarding error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load offboarding
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching offboarding cases. Try again, or sign out and back in if it
        persists.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        Try again
      </button>
    </main>
  );
}
