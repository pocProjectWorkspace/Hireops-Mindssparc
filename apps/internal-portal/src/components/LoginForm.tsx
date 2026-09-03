"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@hireops/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { readSessionClaims } from "@/lib/session-claims";

/**
 * Email + password login. Wave 1 has no magic-link / SSO / signup —
 * users are provisioned by db:seed:test-users (dev) or admin tooling
 * (later). On success we route to /dashboard — the persona-aware landing
 * (DASH-01) that branches per role — (or the `?from=` path the
 * middleware tucked in when it bounced us here).
 *
 * WRONG DOOR. Supabase happily authenticates a candidate or partner here —
 * they are the same auth project — but their token carries no `tid`, so every
 * internal server component used to throw and the caller got a raw
 * "JWT missing required claims" error page with no way out. So we check the
 * token BEFORE navigating: a non-internal identity is signed straight back out
 * and pointed at its own portal. `?reason=not-internal` renders the same
 * message for the server-side backstop in requireAuth().
 */
const NOT_INTERNAL_MSG =
  "That account isn't an internal HireOps account. Candidates sign in at /candidate/login; " +
  "sourcing partners sign in at the partner portal.";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(
    searchParams.get("reason") === "not-internal" ? NOT_INTERNAL_MSG : null,
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setErrorMsg(error.message);
        return;
      }
      const token = data.session?.access_token;
      if (!token || readSessionClaims(token) === null) {
        await supabase.auth.signOut();
        setErrorMsg(NOT_INTERNAL_MSG);
        return;
      }
      const dest = searchParams.get("from") ?? "/dashboard";
      router.replace(dest);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Sign in">
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
    </form>
  );
}
