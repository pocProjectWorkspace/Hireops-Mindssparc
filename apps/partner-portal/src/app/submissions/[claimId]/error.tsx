"use client";

import { useEffect } from "react";

/**
 * Error boundary for a single submission. A claim that isn't the partner's own
 * never reaches here — the page renders that as a calm in-shell notice,
 * because an out-of-date link is an ordinary thing. This boundary is for
 * genuine faults only.
 */
export default function SubmissionDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[partner submission detail error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load this submission
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching this candidate. Try again, or go back to the list of everyone your
        organisation has submitted.
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
          href="/submissions"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Back to your submissions
        </a>
      </div>
    </main>
  );
}
