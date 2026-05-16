"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * Wraps the app in React Query + tRPC providers. Reads the Supabase
 * session per-request via headers() so token rotation (Supabase auto-
 * refreshes ~hourly) doesn't require manual intervention.
 *
 * url: /api/trpc proxies to apps/api by default; if a dedicated proxy
 * isn't running locally, set NEXT_PUBLIC_API_BASE_URL to point at
 * apps/api directly (http://localhost:3001/trpc).
 */
export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Refetch on focus is the React Query default; explicitly
            // keep it on so a recruiter switching tabs gets fresh data.
            refetchOnWindowFocus: true,
            staleTime: 30_000,
            retry: 1,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url:
            process.env.NEXT_PUBLIC_API_BASE_URL ??
            (typeof window !== "undefined" ? `${window.location.origin}/trpc` : "/trpc"),
          async headers() {
            const supabase = getSupabaseBrowserClient();
            const {
              data: { session },
            } = await supabase.auth.getSession();
            return session ? { Authorization: `Bearer ${session.access_token}` } : {};
          },
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
