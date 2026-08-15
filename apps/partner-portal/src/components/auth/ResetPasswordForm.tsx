"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@hireops/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

const MIN_PASSWORD_LENGTH = 8;

/**
 * P1.4 — the landing leg of the reset flow. The emailed link redirects here
 * with a one-time code; @supabase/ssr's browser client exchanges it into a
 * recovery session automatically on load, so this component's job is to WAIT
 * for that session, then let the visitor set a password via updateUser.
 *
 * Three states: checking (the exchange is in flight), ready (form), and
 * invalid (no session materialised — expired/used link). The invalid state
 * routes back to /forgot-password rather than guessing why.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [state, setState] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    // The code exchange may resolve before or after mount — cover both:
    // an immediate session check, plus the auth events for a late exchange.
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && data.session) setState("ready");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        setState("ready");
      }
    });
    // If no session shows up, the link is dead. 5s is generous for the
    // exchange round-trip without stranding a real user on a spinner.
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
      // The recovery session is now a normal session — straight to work.
      router.replace("/");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "checking") {
    return (
      <p className="text-sm text-neutral-500" role="status">
        Checking your reset link…
      </p>
    );
  }

  if (state === "invalid") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600" role="alert">
          This reset link is invalid or has expired. Links are single-use — request a fresh one and
          try again.
        </p>
        <a href="/forgot-password" className="text-sm font-medium text-brand-600 hover:underline">
          Request a new reset link
        </a>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      aria-label="Choose a new password"
    >
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium text-neutral-700">
          New password
        </label>
        <Input
          id="password"
          name="password"
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
          Confirm new password
        </label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {errorMsg && (
        <p role="alert" className="text-sm text-status-error-700">
          {errorMsg}
        </p>
      )}
      <Button type="submit" disabled={submitting} variant="primary">
        {submitting ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}
