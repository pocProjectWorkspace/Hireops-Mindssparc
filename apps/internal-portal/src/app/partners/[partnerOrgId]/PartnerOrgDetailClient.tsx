"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type {
  GetPartnerOrgOutput,
  PartnerOrgAssignmentRow,
  PartnerOrgInvitationRow,
  PartnerOrgUserRow,
  PartnerUserRoleValue,
  RequisitionSummary,
} from "@hireops/api-types";
import { Input, Select, Button } from "@hireops/ui";
import {
  Card,
  Badge,
  StatTile,
  EmptyState,
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
} from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { PageHeader } from "@/components/patterns";
import { humanize } from "@/lib/labels";
import { trpc } from "@/lib/trpc-client";
import { fmtDate, tierLabel } from "../PartnersClient";

/**
 * P0.1B — one partner organisation's administration surface.
 *
 * Four blocks, each backed by a real procedure: the org header (with the
 * suspend / restore toggle), the portal users the org already has, the live
 * invitations (issue + revoke), and the requisition assignments (assign + end,
 * ended rows kept as history — the internal view is the record).
 *
 * The invitation accept link is shown exactly once, in a panel, because that
 * is the truth: only the sha256 of the token is persisted, so once this panel
 * is dismissed the link cannot be recovered — it can only be revoked and
 * re-issued.
 */

/** Requisition statuses it makes sense to hand a partner. */
const ASSIGNABLE_REQ_STATUSES = new Set(["approved", "posted", "on_hold"]);

const PARTNER_ROLE_OPTIONS = [
  { value: "partner_admin", label: "Partner admin" },
  { value: "partner_user", label: "Partner user" },
];

/** ISO → "07 Jul 2026, 14:30". Used where the time matters (invite expiry). */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The API's machine-readable NOT_FOUND messages aren't for humans; its
 * CONFLICT messages already are, so those pass straight through.
 */
function friendlyError(message: string): string {
  switch (message) {
    case "partner_org_not_found":
      return "That partner organisation is no longer here. Reload the page.";
    case "partner_invitation_not_found":
      return "That invitation is no longer here. Reload the page.";
    case "partner_assignment_not_found":
      return "That assignment is no longer here. Reload the page.";
    case "requisition_not_found":
      return "That requisition is no longer here. Reload the page.";
    default:
      return message;
  }
}

export function PartnerOrgDetailClient({
  partnerOrgId,
  initial,
  requisitionOptions,
}: {
  partnerOrgId: string;
  initial: GetPartnerOrgOutput;
  /** null when the session's roles can't read the requisition list (hr_ops). */
  requisitionOptions: RequisitionSummary[] | null;
}) {
  const utils = trpc.useUtils();
  const query = trpc.getPartnerOrg.useQuery(
    { partnerOrgId },
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: false },
  );
  const data = query.data ?? initial;
  const { org, users, pendingInvitations, assignments } = data;

  const refresh = () => {
    void utils.getPartnerOrg.invalidate({ partnerOrgId });
    void utils.listPartnerOrgs.invalidate();
  };

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setActive = trpc.setPartnerOrgActive.useMutation({
    onSuccess: (res) => {
      setError(null);
      setNotice(
        res.active
          ? `${org.name} is active again. Its users can sign in to the partner portal.`
          : `${org.name} is suspended. Its users can no longer sign in; assignments and claims are untouched.`,
      );
      refresh();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  function toggleActive() {
    const next = !org.active;
    const ok = window.confirm(
      next
        ? `Restore ${org.name}? Its portal users will be able to sign in again.`
        : `Suspend ${org.name}? Its portal users will lose access immediately. Existing assignments and claims are kept.`,
    );
    if (!ok) return;
    setActive.mutate({ partnerOrgId, active: next });
  }

  return (
    <PageContainer className="space-y-6">
      <div>
        <Link href="/partners" className="text-sm text-neutral-500 hover:underline">
          ← All partners
        </Link>
      </div>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{org.name}</span>
            <Badge tone={org.tier === "empanelled" ? "accent" : "neutral"}>
              {tierLabel(org.tier)}
            </Badge>
            <Badge tone={org.active ? "success" : "neutral"}>
              {org.active ? "Active" : "Suspended"}
            </Badge>
          </span>
        }
        subtitle={org.legalEntityName ?? undefined}
        right={
          <Button
            variant={org.active ? "secondary" : "primary"}
            onClick={toggleActive}
            disabled={setActive.isPending}
          >
            {setActive.isPending ? "Saving…" : org.active ? "Suspend partner" : "Restore partner"}
          </Button>
        }
      />

      {notice ? (
        <div className="rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Portal users" value={org.userCount} hint="Active partner logins" />
        <StatTile
          label="Active assignments"
          value={org.activeAssignmentCount}
          hint="Requisitions this partner may source against"
        />
        <StatTile
          label="Active claims"
          value={org.activeClaimCount}
          hint="Live candidate ownership claims"
        />
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Contact</h2>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-4">
          <Field label="Primary email" value={org.primaryContactEmail} />
          <Field label="Phone" value={org.primaryContactPhone} />
          <Field label="Country" value={org.country} />
          <Field label="Onboarded" value={fmtDate(org.onboardedAt)} />
        </dl>
      </Card>

      <UsersSection users={users} />

      <InvitationsSection
        partnerOrgId={partnerOrgId}
        orgName={org.name}
        invitations={pendingInvitations}
        onChanged={refresh}
      />

      <AssignmentsSection
        partnerOrgId={partnerOrgId}
        assignments={assignments}
        requisitionOptions={requisitionOptions}
        onChanged={refresh}
      />
    </PageContainer>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </dt>
      <dd className="mt-1 text-neutral-800">{value ?? "—"}</dd>
    </div>
  );
}

// ─────────────────────────── users ───────────────────────────

function UsersSection({ users }: { users: PartnerOrgUserRow[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Portal users</h2>
      {users.length === 0 ? (
        <Card>
          <EmptyState
            title="No portal users yet"
            hint="Invite this partner's first user below. They become a user only once they accept the invitation."
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Name</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Last sign-in</Th>
          </Thead>
          <Tbody>
            {users.map((u) => (
              <Tr key={u.partnerUserId}>
                <Td className="font-medium text-neutral-900">{u.fullName}</Td>
                <Td label="Email">{u.email}</Td>
                <Td label="Role">
                  <Badge tone={u.role === "partner_admin" ? "info" : "neutral"}>
                    {humanize(u.role)}
                  </Badge>
                </Td>
                <Td label="Status">
                  <Badge tone={u.active ? "success" : "neutral"}>
                    {u.active ? "Active" : "Inactive"}
                  </Badge>
                </Td>
                <Td label="Last sign-in">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "Never"}</Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </section>
  );
}

// ──────────────────────── invitations ────────────────────────

function InvitationsSection({
  partnerOrgId,
  orgName,
  invitations,
  onChanged,
}: {
  partnerOrgId: string;
  orgName: string;
  invitations: PartnerOrgInvitationRow[];
  onChanged: () => void;
}) {
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

  const invite = trpc.invitePartnerUser.useMutation({
    onSuccess: (res) => {
      setError(null);
      setIssued({ email: email.trim(), acceptUrl: res.acceptUrl, expiresAt: res.expiresAt });
      setCopied(false);
      setEmail("");
      setFullName("");
      setRole("partner_user");
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  const revoke = trpc.revokePartnerInvitation.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

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

  const canSubmit = email.trim().length > 0 && fullName.trim().length > 0 && !invite.isPending;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Invitations</h2>

      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {issued ? (
        <Card className="border-status-warning-200 bg-status-warning-50 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-status-warning-800">
                Invitation sent to {issued.email}
              </h3>
              <p className="mt-1 text-xs text-status-warning-800">
                The accept link below is shown <strong>only once</strong> — only its hash is stored,
                so it cannot be retrieved again. If you lose it, revoke the invitation and re-issue.
                It expires {fmtDateTime(issued.expiresAt)}.
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

      {invitations.length === 0 ? (
        <p className="text-sm text-neutral-500">No pending invitations.</p>
      ) : (
        <TableShell>
          <Thead>
            <Th>Email</Th>
            <Th>Intended role</Th>
            <Th>Issued</Th>
            <Th>Expires</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Thead>
          <Tbody>
            {invitations.map((inv) => (
              <Tr key={inv.invitationId}>
                <Td className="font-medium text-neutral-900">{inv.email}</Td>
                <Td label="Intended role">
                  <Badge tone={inv.intendedRole === "partner_admin" ? "info" : "neutral"}>
                    {humanize(inv.intendedRole)}
                  </Badge>
                </Td>
                <Td label="Issued">{fmtDateTime(inv.createdAt)}</Td>
                <Td label="Expires">{fmtDateTime(inv.expiresAt)}</Td>
                <Td className="lg:text-right">
                  <button
                    type="button"
                    className="text-sm text-status-error-700 hover:underline disabled:opacity-50"
                    disabled={revoke.isPending}
                    onClick={() => {
                      const ok = window.confirm(
                        `Revoke the invitation for ${inv.email}? Their link stops working immediately.`,
                      );
                      if (!ok) return;
                      revoke.mutate({ invitationId: inv.invitationId });
                    }}
                  >
                    Revoke
                  </button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-neutral-900">Invite a user to {orgName}</h3>
        <p className="mb-4 mt-1 text-xs text-neutral-600">
          Sends the invitation email and returns the accept link here as well, because staging mail
          only reaches one inbox. The invitee&apos;s name is used in the email; it isn&apos;t stored
          on the invitation.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="recruiter@partner.example"
          />
          <Input
            label="Full name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Priya Nair"
          />
          <Select
            label="Role"
            options={PARTNER_ROLE_OPTIONS}
            value={role}
            onValueChange={(v) => setRole(v as PartnerUserRoleValue)}
            hint="Partner admins can manage their own org's users."
          />
        </div>
        <div className="mt-5">
          <Button
            onClick={() => {
              setError(null);
              invite.mutate({
                partnerOrgId,
                email: email.trim(),
                fullName: fullName.trim(),
                role,
              });
            }}
            disabled={!canSubmit}
          >
            {invite.isPending ? "Sending…" : "Send invitation"}
          </Button>
        </div>
      </Card>
    </section>
  );
}

// ──────────────────────── assignments ────────────────────────

function AssignmentsSection({
  partnerOrgId,
  assignments,
  requisitionOptions,
  onChanged,
}: {
  partnerOrgId: string;
  assignments: PartnerOrgAssignmentRow[];
  requisitionOptions: RequisitionSummary[] | null;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");

  const assign = trpc.assignRequisitionToPartner.useMutation({
    onSuccess: () => {
      setError(null);
      setSelected("");
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  const end = trpc.endPartnerAssignment.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(friendlyError(err.message)),
  });

  // A requisition already live with this partner can't be assigned again
  // (the API answers CONFLICT), so it isn't offered.
  const liveRequisitionIds = useMemo(
    () => new Set(assignments.filter((a) => a.status !== "ended").map((a) => a.requisitionId)),
    [assignments],
  );

  const options = useMemo(() => {
    if (!requisitionOptions) return [];
    return requisitionOptions
      .filter((r) => ASSIGNABLE_REQ_STATUSES.has(r.status) && !liveRequisitionIds.has(r.id))
      .map((r) => ({
        value: r.id,
        label: `${r.title ?? "Untitled requisition"} — ${humanize(r.status)}`,
      }));
  }, [requisitionOptions, liveRequisitionIds]);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-neutral-900">Requisition assignments</h2>

      {error ? (
        <div className="rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {assignments.length === 0 ? (
        <p className="text-sm text-neutral-500">
          This partner has never been assigned a requisition, so it sees nothing in the partner
          portal.
        </p>
      ) : (
        <TableShell>
          <Thead>
            <Th>Requisition</Th>
            <Th>Requisition status</Th>
            <Th>Assignment</Th>
            <Th>Assigned</Th>
            <Th>Ended</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </Thead>
          <Tbody>
            {assignments.map((a) => (
              <Tr key={a.assignmentId} className={a.status === "ended" ? "text-neutral-500" : ""}>
                <Td className="font-medium text-neutral-900">{a.title}</Td>
                <Td label="Requisition status">{humanize(a.requisitionStatus)}</Td>
                <Td label="Assignment">
                  <Badge
                    tone={
                      a.status === "active"
                        ? "success"
                        : a.status === "paused"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {humanize(a.status)}
                  </Badge>
                </Td>
                <Td label="Assigned">{fmtDate(a.assignedAt)}</Td>
                <Td label="Ended">{fmtDate(a.endedAt)}</Td>
                <Td className="lg:text-right">
                  {a.status === "ended" ? (
                    <span className="text-sm text-neutral-400">—</span>
                  ) : (
                    <button
                      type="button"
                      className="text-sm text-status-error-700 hover:underline disabled:opacity-50"
                      disabled={end.isPending}
                      onClick={() => {
                        const ok = window.confirm(
                          `End this partner's assignment on "${a.title}"? They lose access to the role and can't submit new candidates. Existing claims are untouched.`,
                        );
                        if (!ok) return;
                        end.mutate({ assignmentId: a.assignmentId });
                      }}
                    >
                      End assignment
                    </button>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}

      <Card className="p-5">
        <h3 className="text-sm font-semibold text-neutral-900">Assign a requisition</h3>
        {requisitionOptions === null ? (
          <p className="mt-1 text-xs text-neutral-600">
            The requisition list isn&apos;t readable with your roles, so the picker is unavailable
            here. An administrator can make the assignment.
          </p>
        ) : (
          <>
            <p className="mb-4 mt-1 text-xs text-neutral-600">
              Approved, posted and on-hold requisitions are offered. Assigning one makes it visible
              in this partner&apos;s portal so they can submit candidates against it.
            </p>
            {options.length === 0 ? (
              <p className="text-sm text-neutral-500">
                No requisitions are available to assign — every open one is already with this
                partner, or none are open yet.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <Select
                  className="min-w-[18rem]"
                  label="Requisition"
                  options={options}
                  value={selected}
                  onValueChange={setSelected}
                  placeholder="Choose a requisition"
                />
                <Button
                  onClick={() => {
                    setError(null);
                    assign.mutate({ partnerOrgId, requisitionId: selected });
                  }}
                  disabled={!selected || assign.isPending}
                >
                  {assign.isPending ? "Assigning…" : "Assign"}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
