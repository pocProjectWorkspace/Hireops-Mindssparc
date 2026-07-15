import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Partner-portal auth gate. Anything not in PUBLIC_PATHS requires a Supabase
 * session; missing session → redirect to /login (carrying `?from=` so
 * post-login lands the caller where they intended). Whether the identity is
 * actually a partner is decided downstream by the api's partnerProcedure —
 * the middleware only proves a session exists.
 *
 * Mirrors apps/internal-portal/middleware.ts; @supabase/ssr's middleware
 * factory needs its own NextRequest cookies adapter, so we can't reuse the
 * lib/ server client here.
 */

const PUBLIC_PATHS = new Set<string>(["/login", "/logout"]);

export async function middleware(req: NextRequest) {
  if (PUBLIC_PATHS.has(req.nextUrl.pathname)) {
    return NextResponse.next();
  }

  // NEXT_PUBLIC_* are inlined at build; a misconfigured deploy should fail
  // closed (bounce to /login) rather than crash the edge middleware.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        res.cookies.set({ name, value: "", ...options });
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("from", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/trpc).*)"],
};
