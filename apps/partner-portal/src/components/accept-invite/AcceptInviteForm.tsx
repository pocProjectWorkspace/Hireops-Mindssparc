"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button, Input } from "@hireops/ui";
import type { PartnerUserRoleValue, RedeemPartnerInvitationOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/**
 * AcceptInviteForm (P0.2) — the wireflows §3.1 "Accept Invite" screen, minus
 * the MFA step (no MFA anywhere in the product yet; it stays on the roadmap
 * alongside magic-link and SSO).
 *
 * The invitation decides the email; the invitee decides their name, phone and
 * password. All three attestations are hard requirements — the API's zod input
 * types them as literal `true`, so the checkbox state is validated here only to
 * give a kinder message than a raw zodError.
 *
 * On success we sign the new account straight in with the SAME Supabase
 * browser client LoginForm uses, so the session cookie the middleware reads is
 * written exactly the same way, then replace to the dashboard. No password is
 * ever re-typed — the one they just chose is the one we sign in with.
 */

const MIN_PASSWORD = 8;

function roleLabel(role: PartnerUserRoleValue): string {
  return role === "partner_admin" ? "Organisation admin" : "Recruiter";
}

function fmtExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const fieldSchema = z
  .object({
    fullName: z.string().trim().min(1, "Tell us your name").max(200),
    phone: z
      .string()
      .trim()
      .max(40)
      .optional()
      .refine((v) => !v || /^\+?[\d\s-]{8,}$/.test(v), "Digits only, with or without country code"),
    password: z.string().min(MIN_PASSWORD, `At least ${MIN_PASSWORD} characters`).max(200),
    confirmPassword: z.string(),
    terms: z.literal(true, { message: "Please accept the Partner Terms of Use" }),
    authority: z.literal(true, { message: "Please confirm you're authorised to accept" }),
    dpdpaConsent: z.literal(true, { message: "Please confirm the consent requirement" }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "The two passwords don't match",
    path: ["confirmPassword"],
  });

type FieldErrors = Partial<Record<keyof z.infer<typeof fieldSchema>, string>>;

export interface AcceptInviteFormProps {
  token: string;
  orgName: string;
  tenantDisplayName: string;
  email: string;
  intendedRole: PartnerUserRoleValue;
  expiresAt: string;
}

export function AcceptInviteForm({
  token,
  orgName,
  tenantDisplayName,
  email,
  intendedRole,
  expiresAt,
}: AcceptInviteFormProps) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [authority, setAuthority] = useState(false);
  const [dpdpaConsent, setDpdpaConsent] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formState, setFormState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "signing_in" }
    | { kind: "error"; msg: string; offerLogin?: boolean }
  >({ kind: "idle" });

  const redeem = trpc.redeemPartnerInvitation.useMutation();
  const busy = formState.kind === "submitting" || formState.kind === "signing_in";

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    const parsed = fieldSchema.safeParse({
      fullName,
      phone: phone || undefined,
      password,
      confirmPassword,
      terms,
      authority,
      dpdpaConsent,
    });
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FieldErrors | undefined;
        if (key && !errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setFormState({ kind: "submitting" });
    let outcome: RedeemPartnerInvitationOutput;
    try {
      outcome = await redeem.mutateAsync({
        token,
        password: parsed.data.password,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        attestations: { terms: true, authority: true, dpdpaConsent: true },
      });
    } catch (err) {
      setFormState({
        kind: "error",
        msg:
          err instanceof Error ? err.message : "We couldn't set up your account. Please try again.",
      });
      return;
    }

    if (outcome.outcome !== "accepted") {
      setFormState({
        kind: "error",
        msg: OUTCOME_COPY[outcome.outcome],
        offerLogin: outcome.outcome === "email_in_use" || outcome.outcome === "already_used",
      });
      return;
    }

    // Account exists — sign in with the credential they just chose.
    setFormState({ kind: "signing_in" });
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: outcome.email,
      password: parsed.data.password,
    });
    if (error) {
      // The account IS created; only the auto-sign-in failed. Say so plainly
      // rather than implying the whole thing went wrong.
      setFormState({
        kind: "error",
        msg: `Your account is ready, but we couldn't sign you in automatically (${error.message}).`,
        offerLogin: true,
      });
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" aria-label="Accept invitation">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
          Welcome to the {tenantDisplayName} partner portal
        </h1>
        <p className="mt-2 text-sm text-neutral-600">
          You&rsquo;ve been invited to access {tenantDisplayName}&rsquo;s hiring partner portal on
          behalf of <strong className="font-medium text-neutral-900">{orgName}</strong> as{" "}
          {roleLabel(intendedRole).toLowerCase()}.
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          This invitation is valid until {fmtExpiry(expiresAt)}.
        </p>
      </div>

      <div className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <h2 className="text-sm font-semibold text-neutral-800">Your details</h2>
        <div>
          <span className="mb-1 block text-sm font-medium text-neutral-700">Email</span>
          <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-base text-neutral-700">
            {email}
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            Fixed by the invitation — your account is created against this address.
          </p>
        </div>
        <Input
          label="Full name"
          type="text"
          required
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={fieldErrors.fullName}
        />
        <Input
          label="Phone (optional)"
          type="tel"
          autoComplete="tel"
          placeholder="+91 98765 43210"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={fieldErrors.phone}
        />
        <Input
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
        />
        <Input
          label="Confirm password"
          type="password"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={fieldErrors.confirmPassword}
        />
      </div>

      <div className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
        <h2 className="text-sm font-semibold text-neutral-800">Before you continue</h2>
        <Attestation
          id="terms"
          checked={terms}
          onChange={setTerms}
          error={fieldErrors.terms}
          label="I have read and agree to the Partner Terms of Use."
        />
        <Attestation
          id="authority"
          checked={authority}
          onChange={setAuthority}
          error={fieldErrors.authority}
          label={`I confirm I am authorised to accept on behalf of ${orgName}.`}
        />
        <Attestation
          id="dpdpa"
          checked={dpdpaConsent}
          onChange={setDpdpaConsent}
          error={fieldErrors.dpdpaConsent}
          label="I understand all candidate data must have DPDPA-compliant consent before submission."
        />
      </div>

      {formState.kind === "error" && (
        <div
          role="alert"
          className="rounded-md border border-status-error-200 bg-status-error-50 px-3.5 py-2.5 text-sm text-status-error-800"
        >
          {formState.msg}
          {formState.offerLogin && (
            <>
              {" "}
              <a href="/login" className="font-medium underline hover:no-underline">
                Sign in instead
              </a>
              .
            </>
          )}
        </div>
      )}

      <Button type="submit" variant="primary" disabled={busy} loading={busy}>
        {formState.kind === "signing_in"
          ? "Signing you in…"
          : formState.kind === "submitting"
            ? "Setting up your account…"
            : "Accept and continue"}
      </Button>
    </form>
  );
}

/** Copy for every non-accepted redemption outcome the API can return. */
type RedeemFailure = Exclude<RedeemPartnerInvitationOutput, { outcome: "accepted" }>["outcome"];

const OUTCOME_COPY: Record<RedeemFailure, string> = {
  invalid: "This invitation link isn't valid. Ask your contact to send a new one.",
  expired: "This invitation has expired. Ask your contact to re-issue it.",
  already_used: "This invitation has already been accepted.",
  revoked: "This invitation was withdrawn by your contact.",
  email_in_use: "An account already exists for this email address.",
};

function Attestation({
  id,
  checked,
  onChange,
  error,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  error?: string;
  label: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-start gap-3 text-sm text-neutral-700">
        <input
          id={id}
          name={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-neutral-300 text-brand-600 focus:ring-2 focus:ring-brand-500"
        />
        <span>{label}</span>
      </label>
      {error && <p className="ml-8 mt-1 text-sm text-status-error-700">{error}</p>}
    </div>
  );
}
