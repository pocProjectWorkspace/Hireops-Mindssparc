"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@hireops/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * Partner email + password login. Wave 1 has no magic-link / MFA / SSO
 * (those are on the roadmap per partner-wireflows §3.1); partner users are
 * provisioned by db:seed:partner-demo (dev) or the invitation flow (later).
 *
 * On success we route to the dashboard (`/`) or the `?from=` path the
 * middleware tucked away. The identity might authenticate with Supabase but
 * NOT be a partner — that rejection is surfaced by the dashboard, which calls
 * partnerGetMe and renders the "not a partner account" state on FORBIDDEN.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    // Set once the redirect is under way, so `finally` leaves the button in its
    // pending state instead of flipping it back mid-navigation.
    let navigating = false;
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setErrorMsg(error.message);
        return;
      }
      const dest = searchParams.get("from") ?? "/";
      router.replace(dest);
      router.refresh();
      // Deliberately do NOT clear `submitting` here. router.replace() is not
      // awaited, and on a cold serverless start the destination can take ~15s
      // to render — clearing it flipped the button back to an enabled "Sign in"
      // while the navigation was still in flight, so a tester saw the form go
      // idle with nothing happening and reported login as broken (it wasn't).
      // The component unmounts when the route changes, so this never leaks.
      navigating = true;
      return;
    } finally {
      // Only the failure paths above land here with the form still mounted.
      if (!navigating) setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Partner sign in">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium text-neutral-700">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium text-neutral-700">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {errorMsg && (
        <p role="alert" className="text-sm text-status-error-700">
          {errorMsg}
        </p>
      )}
      <Button type="submit" disabled={submitting} variant="primary">
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
      <a
        href="/forgot-password"
        className="text-center text-sm font-medium text-brand-600 hover:underline"
      >
        Forgot password?
      </a>
    </form>
  );
}
