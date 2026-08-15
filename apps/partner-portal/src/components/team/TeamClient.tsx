"use client";

import { useState, type FormEvent } from "react";
import { TRPCClientError } from "@trpc/client";
import { Button, Input } from "@hireops/ui";
import type { PartnerListTeamOutput, PartnerUserRoleValue } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Badge, Card, EmptyState } from "@/components/ui";
import { fmtDate } from "@/components/reqs/req-format";

/**
 * TeamClient (P1.3, partner-wireflows §3.12) — the partner org admin's own
 * user management: who is in the org, who has been invited, invite someone new,
 * suspend or reactivate a teammate.
 *
 * Client component because all three actions are mutations that must re-read
 * the list. The server component next door does the first fetch and hands it in
 * as `initialTeam`, so the first paint is real data (no spinner) and the query
 * afterwards is just the refresh channel.
 *
 * The one-time accept-link panel is the internal portal's P0.1B pattern rebuilt
 * on this app's primitives — same discipline it exists for: only the token's
 * sha256 is stored, so the link is shown exactly once and cannot be retrieved
 * again.
 */

function roleLabel(role: PartnerUserRoleValue): string {
  return role === "partner_admin" ? "Org admin" : "Recruiter";
}

/**
 * The API's machine-readable messages, said in the partner's language. Anything
 * unrecognised falls through verbatim — the CONFLICT messages the shared invite
 * core raises are already written for a human.
 */
function friendlyError(err: unknown): string {
  if (err instanceof TRPCClientError) {
    const msg = String(err.message);
    if (msg === "partner_admin_only") return "Only your organisation's admin can do that.";
    if (msg === "cannot_deactivate_self") return "You can't suspend your own access.";
    if (msg === "partner_user_not_in_org")
      return "That teammate is no longer in your organisation.";
    return msg;
  }
  return "Something went wrong. Please try again.";
}

export function TeamClient({
  initialTeam,
  orgName,
}: {
  initialTeam: PartnerListTeamOutput;
  orgName: string;
}) {
  const team = trpc.partnerListTeam.useQuery(undefined, { initialData: initialTeam });
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    email: string;
    acceptUrl: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<PartnerUserRoleValue>("partner_user");

  const invite = trpc.partnerInviteTeammate.useMutation({
    onSuccess: (res, vars) => {
      setError(null);
      setIssued({ email: vars.email.trim(), acceptUrl: res.acceptUrl, expiresAt: res.expiresAt });
      setCopied(false);
      setEmail("");
      setFullName("");
      setRole("partner_user");
      void team.refetch();
    },
    onError: (err) => setError(friendlyError(err)),
  });

  const setActive = trpc.partnerSetTeammateActive.useMutation({
    onSuccess: () => {
      setError(null);
      void team.refetch();
    },
    onError: (err) => setError(friendlyError(err)),
  });

  // P1.4 — a mistyped address no longer waits out its 7-day expiry.
  const revoke = trpc.partnerRevokeInvitation.useMutation({
    onSuccess: () => {
      setError(null);
      void team.refetch();
    },
    onError: (err) => setError(friendlyError(err)),
  });

  const members = team.data?.members ?? [];
  const invitations = team.data?.invitations ?? [];
  const busy = invite.isPending || setActive.isPending || revoke.isPending;

  function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedName = fullName.trim();
    if (!trimmedEmail || !trimmedName) {
      setError("Give the teammate's name and email.");
      return;
    }
    invite.mutate({ email: trimmedEmail, fullName: trimmedName, role });
  }

  function onRevoke(invitationId: string, inviteeEmail: string) {
    const question = `Revoke the invitation for ${inviteeEmail}? Their link stops working immediately; you can re-invite them any time.`;
    if (typeof window !== "undefined" && !window.confirm(question)) return;
    revoke.mutate({ invitationId });
  }

  function onToggleActive(partnerUserId: string, nextActive: boolean, name: string) {
    const question = nextActive
      ? `Restore portal access for ${name}?`
      : `Suspend ${name}? They will be signed out of the partner portal until you restore them. Their submissions are unaffected.`;
    if (typeof window !== "undefined" && !window.confirm(question)) return;
    setActive.mutate({ partnerUserId, active: nextActive });
  }

  async function copyLink() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.acceptUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Your team</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Everyone at {orgName} with access to this portal. Invite recruiters, and suspend access
          when someone leaves.
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-card border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-800"
        >
          {error}
        </div>
      ) : null}

      {/* One-time accept link. Shown once, by design. */}
      {issued ? (
        <Card className="border-status-warning-200 bg-status-warning-50">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-status-warning-800">
                Invitation sent to {issued.email}
              </h2>
              <p className="mt-1 text-xs text-status-warning-800">
                We&rsquo;ve emailed them the link. It is shown here <strong>only once</strong> —
                only its fingerprint is stored, so it can&rsquo;t be retrieved again. It expires{" "}
                {fmtDate(issued.expiresAt)}.
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 text-sm text-neutral-600 hover:underline"
              onClick={() => setIssued(null)}
            >
              Dismiss
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-button border border-status-warning-200 bg-white px-3 py-2 text-xs text-neutral-800">
              {issued.acceptUrl}
            </code>
            <Button variant="secondary" onClick={copyLink}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Teammates */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">Teammates</h2>
        <Card padded={false}>
          <ul className="divide-y divide-neutral-100">
            {members.map((m) => (
              <li
                key={m.partnerUserId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-900">
                    {m.fullName}
                    {m.isSelf ? <span className="ml-2 text-neutral-500">(you)</span> : null}
                  </p>
                  <p className="truncate text-sm text-neutral-500">
                    {m.email} ·{" "}
                    {m.lastLoginAt ? `last signed in ${fmtDate(m.lastLoginAt)}` : "never signed in"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={m.role === "partner_admin" ? "accent" : "neutral"}>
                    {roleLabel(m.role)}
                  </Badge>
                  <Badge tone={m.active ? "success" : "warning"}>
                    {m.active ? "Active" : "Suspended"}
                  </Badge>
                  {m.isSelf ? (
                    <span className="text-sm text-neutral-400">—</span>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => onToggleActive(m.partnerUserId, !m.active, m.fullName)}
                    >
                      {m.active ? "Suspend" : "Reactivate"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {/* Pending invitations */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">
          Pending invitations
        </h2>
        {invitations.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No invitations outstanding"
              hint="Invite a recruiter below and their link will be listed here until they accept it."
            />
          </Card>
        ) : (
          <Card padded={false}>
            <ul className="divide-y divide-neutral-100">
              {invitations.map((i) => (
                <li
                  key={i.invitationId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <p className="min-w-0 truncate text-sm text-neutral-900">{i.email}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone="neutral">{roleLabel(i.intendedRole)}</Badge>
                    <span className="text-sm text-neutral-500">expires {fmtDate(i.expiresAt)}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onRevoke(i.invitationId, i.email)}
                      className="text-sm font-medium text-status-error-700 hover:underline disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {/* Invite */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">Invite teammate</h2>
        <Card>
          <form onSubmit={onInvite} className="flex flex-col gap-4" aria-label="Invite a teammate">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input
                label="Full name"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
              <Input
                label="Work email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="team-role" className="text-sm font-medium text-neutral-700">
                Role
              </label>
              <select
                id="team-role"
                name="team-role"
                value={role}
                onChange={(e) => setRole(e.target.value as PartnerUserRoleValue)}
                className="min-h-[44px] w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500 sm:max-w-xs"
              >
                <option value="partner_user">Recruiter — submit and track candidates</option>
                <option value="partner_admin">Org admin — also manages this team</option>
              </select>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy} loading={invite.isPending}>
                Send invitation
              </Button>
            </div>
          </form>
        </Card>
      </section>
    </div>
  );
}
