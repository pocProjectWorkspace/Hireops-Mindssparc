"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@hireops/ui";
import { Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import { TRPCClientError } from "@trpc/client";

/**
 * Set-a-password activation flow. The candidate arrives from the emailed
 * signed link; they choose a password; completeCandidateActivation creates
 * their Supabase auth user + activates the account (consuming the link). On
 * success we send them to sign in with the email prefilled.
 */
export function CandidateActivateClient({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const complete = trpc.completeCandidateActivation.useMutation();

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    if (password.length < 8) {
      setErrorMsg("Choose a password of at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setErrorMsg("Those passwords don't match.");
      return;
    }
    try {
      const res = await complete.mutateAsync({ token, password });
      setDone(true);
      // Give the success screen a beat, then bounce to sign in prefilled.
      setTimeout(() => {
        router.replace(`/candidate/login?email=${encodeURIComponent(res.email)}`);
      }, 1600);
    } catch (err) {
      setErrorMsg(friendlyError(err));
    }
  }

  if (done) {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState
            title="Account activated"
            hint="Taking you to sign in — use the password you just set."
          />
        </Card>
      </CandidateShell>
    );
  }

  return (
    <CandidateShell>
      <Card className="flex flex-col gap-5 p-6">
        <header className="flex flex-col gap-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            Set your password
          </h1>
          <p className="text-sm text-neutral-600">
            Choose a password to finish activating your candidate account.
          </p>
        </header>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Set password">
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-neutral-700">
              New password
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              required
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
              name="confirm"
              type="password"
              required
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
          <Button
            type="submit"
            variant="primary"
            disabled={complete.isPending}
            loading={complete.isPending}
          >
            Activate account
          </Button>
        </form>
      </Card>
    </CandidateShell>
  );
}

function friendlyError(err: unknown): string {
  if (err instanceof TRPCClientError) {
    const msg = String(err.message ?? "");
    if (msg.includes("already_used")) {
      return "This link has already been used. Try signing in, or request a new link.";
    }
    if (msg.includes("expired")) {
      return "This link has expired. Request a new one from the sign-in page.";
    }
    if (msg.startsWith("activation_link_") || msg.includes("invalid")) {
      return "This link is invalid. Request a new one from the sign-in page.";
    }
  }
  return "Something went wrong activating your account. Please try again.";
}
