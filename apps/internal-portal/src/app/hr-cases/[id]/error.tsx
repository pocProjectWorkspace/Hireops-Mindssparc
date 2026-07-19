"use client";

import { useEffect } from "react";

export default function HrCaseDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[hr-case detail error]", error);
  }, [error]);

  return (
    <main className="mx-auto mt-12 max-w-prose rounded-md border border-status-error-500 bg-status-error-50 p-6">
      <h1 className="mb-2 text-xl font-semibold text-status-error-700">
        Couldn&apos;t load HR case
      </h1>
      <p className="mb-4 text-sm text-neutral-700">
        We hit an error fetching this case. Try again, or return to the HR cases list.
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
