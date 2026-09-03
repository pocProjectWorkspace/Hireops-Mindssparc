import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * POST /logout — clears the Supabase session cookie and redirects to
 * /login. GET also accepted so a plain `<a href="/logout">` works for
 * the simple case. POST is recommended (cross-site-fetch safety),
 * which Module 1b can enforce when it ships the navigation primitive.
 *
 * `?reason=` is forwarded to /login so a forced sign-out can explain itself
 * — requireAuth() sends a candidate/partner who signed in at the internal
 * door here with `reason=not-internal`.
 */

export async function POST(req: NextRequest) {
  return handleLogout(req);
}

export async function GET(req: NextRequest) {
  return handleLogout(req);
}

async function handleLogout(req: NextRequest) {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  const dest = new URL("/login", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002");
  const reason = req.nextUrl.searchParams.get("reason");
  if (reason) {
    dest.searchParams.set("reason", reason);
  }
  return NextResponse.redirect(dest);
}
