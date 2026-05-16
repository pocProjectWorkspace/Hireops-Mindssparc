"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@hireops/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * Email + password login. Wave 1 has no magic-link / SSO / signup —
 * users are provisioned by db:seed:test-users (dev) or admin tooling
 * (later). On success we route to /triage (or the `?from=` path the
 * middleware tucked in when it bounced us here).
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
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setErrorMsg(error.message);
        return;
      }
      const dest = searchParams.get("from") ?? "/triage";
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
