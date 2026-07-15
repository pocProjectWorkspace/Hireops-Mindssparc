import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

/**
 * POST /logout — clears the Supabase session cookie and redirects to /login.
 * GET also accepted so a plain `<a href="/logout">` works (the shell's sign-out
 * link). Mirrors apps/internal-portal/logout; the fallback host is the partner
 * portal's 3005 dev port.
 */

export async function POST() {
  return handleLogout();
}

export async function GET() {
  return handleLogout();
}

async function handleLogout() {
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(
    new URL("/login", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3005"),
  );
}
