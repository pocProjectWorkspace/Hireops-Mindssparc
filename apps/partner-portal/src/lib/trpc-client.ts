"use client";

import { createTRPCReact } from "@trpc/react-query";
import { TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@hireops/api/trpc";

/**
 * Strongly-typed tRPC React Query hooks. Consumers do:
 *   const { data, isLoading } = trpc.listCandidates.useQuery(input);
 *   const mutate = trpc.submitApplication.useMutation();
 *
 * The AppRouter type comes from @hireops/api/trpc (the side-effect-free
 * entry added in API-01); importing from the apps/api root would also
 * pull in the Hono server bootstrap.
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Centralised tRPC error handler. UNAUTHORIZED triggers a forced
 * logout-and-redirect (session expired); FORBIDDEN and unknown errors
 * surface as a toast; BAD_REQUEST + zodError is left for the caller
 * (the caller knows which fields its form has).
 *
 * Wire this into a useQuery / useMutation's onError, or call it
 * directly from a try/catch around an invalidation.
 */
export function handleTRPCError(err: unknown, opts: { onMessage?: (msg: string) => void } = {}) {
  const notify = opts.onMessage ?? defaultNotify;
  if (err instanceof TRPCClientError) {
    const code = err.data?.code as string | undefined;
    if (code === "UNAUTHORIZED") {
      notify("Session expired, redirecting to login");
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      return;
    }
    if (code === "FORBIDDEN") {
      notify("You don't have permission for that action");
      return;
    }
    if (code === "BAD_REQUEST" && err.data?.zodError) {
      // Form caller renders the per-field errors itself.
      return;
    }
    if (code === "NOT_FOUND") {
      notify("That record was not found");
      return;
    }
  }
  notify("Something went wrong. Please try again.");
}

function defaultNotify(msg: string): void {
  // Toast infrastructure ships in Module 1b. For now log + alert is
  // honest about the unfinished state; replace with a proper toast
  // when the primitive lands.
  console.warn("[trpc]", msg);
  if (typeof window !== "undefined") {
    window.alert(msg);
  }
}
