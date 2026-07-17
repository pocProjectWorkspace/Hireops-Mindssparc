"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input, type InputType } from "@hireops/ui";
import { Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * Candidate sign-in + first-time activation request.
 *
 * Two modes on one surface:
 *   - "signin": email + password → Supabase → /candidate. A signed-in
 *     identity that isn't a candidate is surfaced calmly by the dashboard.
 *   - "activate": email only → requestCandidateActivation → an always-the-same
 *     "if the email exists, we've sent a link" confirmation (no enumeration).
 */

const DEFAULT_TENANT_SLUG = process.env.NEXT_PUBLIC_DEFAULT_TENANT_SLUG?.trim() || "kyndryl-poc";

type Mode = "signin" | "activate";

export function CandidateLoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantSlug = searchParams.get("tenant")?.trim() || DEFAULT_TENANT_SLUG;

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activationSent, setActivationSent] = useState(false);

  const requestActivation = trpc.requestCandidateActivation.useMutation();

  async function handleSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setErrorMsg("That email and password didn't match. Try again, or activate your account.");
        return;
      }
      router.replace("/candidate");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleActivate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await requestActivation.mutateAsync({ email, tenantSlug });
      setActivationSent(true);
    } catch {
      // Even on an unexpected error we show the same neutral confirmation so
      // the surface never reveals whether an account exists.
      setActivationSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (activationSent) {
    return (
      <Card className="flex flex-col gap-3 p-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Check your email</h1>
        <p className="text-sm text-neutral-600">
          If an account exists for <strong>{email}</strong>, we&rsquo;ve sent a link to set your
          password. It can be used once and expires soon.
        </p>
        <button
          type="button"
          className="mt-2 text-sm font-medium text-brand-600 underline"
          onClick={() => {
            setActivationSent(false);
            setMode("signin");
          }}
        >
          Back to sign in
        </button>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
          {mode === "signin" ? "Candidate sign in" : "Activate your account"}
        </h1>
        <p className="text-sm text-neutral-600">
          {mode === "signin"
            ? "Track your applications and confirm interviews."
            : "Enter the email you applied with — we'll send a link to set a password."}
        </p>
      </header>

      {mode === "signin" ? (
        <form
          onSubmit={handleSignIn}
          className="flex flex-col gap-4"
          aria-label="Candidate sign in"
        >
          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
          />
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
          />
          {errorMsg ? (
            <p role="alert" className="text-sm text-status-error-700">
              {errorMsg}
            </p>
          ) : null}
          <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
            Sign in
          </Button>
          <p className="text-center text-sm text-neutral-600">
            First time here?{" "}
            <button
              type="button"
              className="font-medium text-brand-600 underline"
              onClick={() => {
                setMode("activate");
                setErrorMsg(null);
              }}
            >
              Activate your account
            </button>
          </p>
        </form>
      ) : (
        <form
          onSubmit={handleActivate}
          className="flex flex-col gap-4"
          aria-label="Activate account"
        >
          <Field
            id="activate-email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
          />
          <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
            Send activation link
          </Button>
          <p className="text-center text-sm text-neutral-600">
            <button
              type="button"
              className="font-medium text-brand-600 underline"
              onClick={() => {
                setMode("signin");
                setErrorMsg(null);
              }}
            >
              Back to sign in
            </button>
          </p>
        </form>
      )}
    </Card>
  );
}

function Field({
  id,
  label,
  type,
  autoComplete,
  value,
  onChange,
}: {
  id: string;
  label: string;
  type: InputType;
  autoComplete: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-neutral-700">
        {label}
      </label>
      <Input
        id={id}
        name={id}
        type={type}
        required
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
