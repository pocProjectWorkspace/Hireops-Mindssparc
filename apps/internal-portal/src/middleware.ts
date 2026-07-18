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

const PUBLIC_PATHS = new Set<string>(["/login", "/logout", "/privacy", "/candidate/login"]);

// Path prefixes that are always public (candidate-side flows). Each
// entry must end with "/" so a literal segment match doesn't bleed.
// `/interviews/confirm/` is public (candidate confirm link) while the
// `/interviews` recruiter list stays auth-gated. `/candidate/activate/` is
// the set-password page reached from the emailed activation link.
const PUBLIC_PREFIXES = ["/offer/", "/t/", "/interviews/confirm/", "/candidate/activate/"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return NextResponse.next();
    }
  }

  // Candidate surfaces (/candidate/*) require a Supabase session but bounce
  // to the CANDIDATE login, not the internal one. (The dashboard additionally
  // resolves the candidate identity server/API-side; a signed-in non-candidate
  // gets a calm "not a candidate account" there.)
  const isCandidateArea = pathname === "/candidate" || pathname.startsWith("/candidate/");

  // NEXT_PUBLIC_* are inlined at build; a misconfigured deploy should fail
  // closed (bounce to login) rather than crash the middleware. Mirrors
  // apps/partner-portal/src/middleware.ts.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    const url = req.nextUrl.clone();
    url.pathname = isCandidateArea ? "/candidate/login" : "/login";
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
    url.pathname = isCandidateArea ? "/candidate/login" : "/login";
    if (!isCandidateArea) {
      url.searchParams.set("from", req.nextUrl.pathname);
    }
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  // Skip Next internals + static asset routes.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/trpc).*)"],
};
