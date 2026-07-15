"use client";

import { useEffect } from "react";

/**
 * Root error boundary for the partner dashboard segment. Catches errors thrown
 * inside the server component (e.g. tRPC procedure rejections other than the
 * handled FORBIDDEN). Reset re-renders the segment.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[partner dashboard error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load your dashboard
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching your requisitions. Try again, or sign out and back in if it
        persists.
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
          href="/logout"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Sign out
        </a>
      </div>
    </main>
  );
}
