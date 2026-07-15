"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getEnv } from "./env";

/**
 * Browser Supabase client. Singleton per browser tab; sharing the
 * instance across components keeps the auth subscription single-fire.
 *
 * Used for: login mutations, the client-side session lookup inside the
 * TRPCProvider (to attach the Authorization header), session listeners.
 */
let cached: ReturnType<typeof createBrowserClient> | undefined;

export function getSupabaseBrowserClient() {
  if (cached) return cached;
  const env = getEnv();
  cached = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return cached;
}
