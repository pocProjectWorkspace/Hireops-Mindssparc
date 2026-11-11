"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@hireops/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

const MIN_PASSWORD_LENGTH = 8;

/**
 * C1-F11 — set a password after following an invitation link. Same shape as
 * the partner portal's reset form: wait for the session the invite link
 * establishes, then updateUser({ password }) and go to the setup wizard.
 */
export function AcceptInviteForm() {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && data.session) setState("ready");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === "SIGNED_IN" || event === "PASSWORD_RECOVERY")) setState("ready");
    });
    const timer = setTimeout(() => {
      setState((s) => (s === "checking" ? "invalid" : s));
    }, 5000);
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMsg(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setErrorMsg("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setErrorMsg(error.message);
        return;
      }
      // Refresh so the access-token hook issues the tenant claims, then start setup.
      await supabase.auth.refreshSession();
      router.replace("/setup");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "checking") {
    return (
      <p className="text-sm text-neutral-500" role="status">
        Checking your invitation…
      </p>
    );
  }
  if (state === "invalid") {
    return (
      <p className="text-sm text-neutral-600" role="alert">
        This invitation link is invalid or has expired. Ask your HireOps contact to send a new one.
      </p>
    );
  }
  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Choose a password">
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium text-neutral-700">
          Password
        </label>
        <Input
          id="password"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-neutral-700">
          Confirm password
        </label>
        <Input
          id="confirm"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {errorMsg ? (
        <p role="alert" className="text-sm text-status-error-700">
          {errorMsg}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting} variant="primary">
        {submitting ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
