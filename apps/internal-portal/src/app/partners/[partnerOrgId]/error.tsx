"use client";

import { useEffect } from "react";

/**
 * Per-route error boundary for a partner-org detail server-component failure.
 * A missing org is handled in the page as a calm notice, so anything reaching
 * here is a genuine fault. Reset re-renders the segment.
 */
export default function PartnerOrgDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[partners/[partnerOrgId] error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load this partner
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching the organisation. Try again, or go back to the partner list if it
        persists.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Try again
        </button>
        <a href="/partners" className="text-sm text-neutral-600 hover:underline">
          All partners
        </a>
      </div>
    </main>
  );
}
