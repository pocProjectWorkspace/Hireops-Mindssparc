import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { getEnv } from "./env";

/**
 * Server-component / route-handler Supabase client. Reads + writes the
 * session cookie via Next's cookies() API. Used by:
 *   - middleware.ts (separate factory there — gets cookies via NextRequest)
 *   - server components that need the session (lib/auth.ts wraps this)
 *   - route handlers that need to mutate the session (/logout)
 *
 * IMPORTANT: don't call this from a client component. The cookies()
 * API only works server-side; calling it in a client component throws
 * at runtime with a confusing message.
 */
export function createSupabaseServerClient() {
  const env = getEnv();
  const cookieStore = cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // set() throws in pure-read server-component contexts; the
          // middleware path catches this case before we get here. For
          // server components the catch lets us still read the session
          // even if Next refuses the write.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: "", ...options });
        } catch {
          // see set() above.
        }
      },
    },
  });
}
