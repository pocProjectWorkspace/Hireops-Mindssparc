import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Auth gate. Anything not in PUBLIC_PATHS requires an authenticated
 * Supabase session; missing session → redirect to /login (with the
 * caller's path in `?from=` so post-login we can land them where they
 * intended). Static assets and the Next.js internals are exempt via
 * the matcher pattern.
 *
 * @supabase/ssr's middleware factory takes its own cookies adapter
 * (NextRequest cookies, not next/headers cookies) so we can't reuse
 * createSupabaseServerClient from lib/. The duplication is small and
 * the alternative — a generic factory accepting either context — adds
 * indirection that hides which environment is running.
 */

const PUBLIC_PATHS = new Set<string>(["/login", "/logout"]);

// Path prefixes that are always public (candidate-side flows). Each
// entry must end with "/" so a literal segment match doesn't bleed.
const PUBLIC_PREFIXES = ["/offer/"];

export async function middleware(req: NextRequest) {
  if (PUBLIC_PATHS.has(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  for (const prefix of PUBLIC_PREFIXES) {
    if (req.nextUrl.pathname.startsWith(prefix)) {
      return NextResponse.next();
    }
  }

  const res = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
    },
  );

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
  // Skip Next internals + static asset routes.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/trpc).*)"],
};
