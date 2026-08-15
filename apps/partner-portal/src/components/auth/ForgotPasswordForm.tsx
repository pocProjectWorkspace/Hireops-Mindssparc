"use client";

import { useState, type FormEvent } from "react";
import { Button, Input } from "@hireops/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * P1.4 — request a Supabase password-reset email. The submitted state is the
 * SAME regardless of whether the address has an account: confirming "no such
 * account" to an anonymous visitor is an enumeration oracle, so the page
 * never does. (Supabase's own API behaves the same way.)
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      // Rate limits and transport failures are worth surfacing; "user not
      // found" never comes back from this endpoint, so this leaks nothing.
      if (error) {
        setErrorMsg(error.message);
        return;
      }
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <p className="text-sm text-neutral-600" role="status">
        If that address has a partner account, a reset link is on its way. The link is valid for a
        limited time — check your spam folder if it doesn&apos;t arrive.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Reset your password">
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
      {errorMsg && (
        <p role="alert" className="text-sm text-status-error-700">
          {errorMsg}
        </p>
      )}
      <Button type="submit" disabled={submitting} variant="primary">
        {submitting ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
