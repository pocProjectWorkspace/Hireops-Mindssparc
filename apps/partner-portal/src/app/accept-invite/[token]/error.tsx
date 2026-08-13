"use client";

import { useEffect } from "react";

/**
 * Error boundary for the accept-invite segment. Note what does NOT land here:
 * an expired, revoked, already-used or unrecognised token is a normal state
 * the page renders as a card. This boundary only catches genuine faults — the
 * database being unreachable, say — so its copy is about retrying, not about
 * the invitation.
 */
export default function AcceptInviteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[accept-invite error]", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-lg rounded-md border border-status-error-500 bg-status-error-50 p-6">
        <h1 className="mb-2 text-lg font-semibold text-status-error-700">
          Couldn&apos;t open your invitation
        </h1>
        <p className="mb-4 text-sm text-neutral-700">
          Something went wrong on our side while loading this invitation. Try again — if it keeps
          happening, ask your HireOps contact to re-issue the invitation.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
