"use client";

import { useEffect } from "react";

/**
 * Error boundary for the /submissions segment. Note what does NOT land here:
 * a claim that belongs to another org is a normal state the detail page
 * renders as a calm notice. This catches genuine faults only.
 */
export default function SubmissionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[partner submissions error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load your submissions
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching the candidates your organisation has submitted. Try again, or sign
        out and back in if it persists.
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
          href="/"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Back to dashboard
        </a>
      </div>
    </main>
  );
}
