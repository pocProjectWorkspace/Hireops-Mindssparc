"use client";

import { useEffect } from "react";

/**
 * Error boundary for a single requisition. A req that isn't assigned to the
 * partner's org never reaches here — the page renders that as a calm in-shell
 * notice, because it's an ordinary thing for a stale link to produce. This
 * boundary is for genuine faults only.
 */
export default function RequisitionDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[partner req detail error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load this requisition
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching the role. Try again, or go back to your list of assigned
        requisitions.
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
          href="/reqs"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Back to your reqs
        </a>
      </div>
    </main>
  );
}
