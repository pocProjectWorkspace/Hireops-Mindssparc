"use client";

import { useMemo, useState } from "react";
import {
  INTERNAL_TENANT_ROLES,
  type InternalTenantRole,
  type TenantUserAdminRow,
} from "@hireops/api-types";
import { Input, Button, Checkbox } from "@hireops/ui";
import { Card, Badge, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Users & roles admin (CONF-03). List memberships, edit internal roles,
 * deactivate/reactivate, and invite a new member. NO email is sent this
 * ticket — an invite returns a temp password shown once (copy-to-clipboard),
 * with an honest note that email invitations arrive with the notifications
 * work package.
 *
 * Self-guards are enforced server-side (an admin can't remove their own admin
 * role or deactivate themselves); the client mirrors them as disabled controls
 * so the affordance never dead-ends in an error.
 */

function roleLabel(role: string): string {
  return role
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function UsersAdminClient({ initialUsers }: { initialUsers: TenantUserAdminRow[] }) {
  const utils = trpc.useUtils();
  const usersQuery = trpc.listTenantUsersAdmin.useQuery(
    {},
    { initialData: { items: initialUsers } },
  );
  const users = usersQuery.data?.items ?? initialUsers;

  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => utils.listTenantUsersAdmin.invalidate();

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <p className="max-w-prose text-sm text-neutral-600">
          Internal team members and their roles for this tenant. Role and status changes take effect
          the next time the member signs in (the access token is stamped at sign-in).
        </p>
      </div>

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}

      <InvitePanel onInvited={(msg) => setNotice(msg)} onChanged={refresh} />

      <Card className="mt-6 p-0">
        <TableShell className="border-0">
          <Thead>
            <Th>Member</Th>
            <Th>Roles</Th>
            <Th>Status</Th>
            <Th>Actions</Th>
          </Thead>
          <Tbody>
            {users.length === 0 ? (
              <Tr>
                <Td colSpan={4} className="text-neutral-500">
                  No members yet.
                </Td>
              </Tr>
            ) : (
              users.map((u) => <UserRow key={u.membershipId} user={u} onChanged={refresh} />)
            )}
          </Tbody>
        </TableShell>
      </Card>
    </div>
  );
}

function InvitePanel({
  onInvited,
  onChanged,
}: {
  onInvited: (msg: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roles, setRoles] = useState<Set<InternalTenantRole>>(new Set(["recruiter"]));
  const [result, setResult] = useState<{
    email: string;
    tempPassword: string;
    note: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invite = trpc.inviteTenantUser.useMutation({
    onSuccess: (res) => {
      const note = res.membershipReused
        ? "This email already had a membership here — its roles were updated and it was reactivated."
        : res.alreadyExisted
          ? "This email already had a login — its password was reset to the one below."
          : "New member created.";
      setResult({ email: res.email, tempPassword: res.tempPassword, note });
      setError(null);
      setEmail("");
      setDisplayName("");
      setRoles(new Set(["recruiter"]));
      onInvited(`Invited ${res.email}.`);
      onChanged();
    },
    onError: (err) => setError(err.message),
  });

  function toggleRole(role: InternalTenantRole) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  async function copyPassword() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Invite a member
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">Invite a member</h2>
        <button
          type="button"
          className="text-sm text-neutral-500 hover:underline"
          onClick={() => {
            setOpen(false);
            setResult(null);
            setError(null);
          }}
        >
          Close
        </button>
      </div>

      {result ? (
        <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-4">
          <p className="text-sm font-medium text-neutral-900">Invited {result.email}</p>
          <p className="mt-1 text-xs text-neutral-600">{result.note}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="rounded bg-white px-2 py-1 font-mono text-sm text-neutral-800">
              {result.tempPassword}
            </code>
            <Button variant="secondary" onClick={copyPassword}>
              {copied ? "Copied" : "Copy password"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            This temporary password is shown once — copy it now and share it securely. No email is
            sent yet; email invitations arrive with the notifications work package.
          </p>
          <div className="mt-3">
            <button
              type="button"
              className="text-sm text-brand-700 hover:underline"
              onClick={() => setResult(null)}
            >
              Invite another
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@company.com"
            />
            <Input
              label="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-neutral-700">Roles</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {INTERNAL_TENANT_ROLES.map((role) => (
                <Checkbox
                  key={role}
                  checked={roles.has(role)}
                  onCheckedChange={() => toggleRole(role)}
                  label={roleLabel(role)}
                />
              ))}
            </div>
          </div>
          {error ? <p className="text-sm text-status-error-700">{error}</p> : null}
          <div className="flex items-center gap-3">
            <Button
              onClick={() =>
                invite.mutate({
                  email: email.trim(),
                  displayName: displayName.trim() || undefined,
                  roles: [...roles],
                })
              }
              disabled={invite.isPending || !email.trim() || roles.size === 0}
            >
              {invite.isPending ? "Inviting…" : "Create invite"}
            </Button>
            <span className="text-xs text-neutral-500">
              Creates a login + membership and shows a one-time password (no email sent).
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function UserRow({ user, onChanged }: { user: TenantUserAdminRow; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = user.status === "active";

  const updateRoles = trpc.updateMembershipRoles.useMutation({
    onSuccess: () => {
      setEditing(false);
      setError(null);
      onChanged();
    },
    onError: (err) => setError(err.message),
  });
  const setStatus = trpc.setMembershipStatus.useMutation({
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(err.message),
  });

  return (
    <>
      <Tr>
        <Td>
          <span className="font-medium text-neutral-800">
            {user.displayName ?? user.email ?? "—"}
          </span>
          {user.isSelf ? <span className="ml-2 text-xs text-neutral-400">(you)</span> : null}
          {user.displayName && user.email ? (
            <span className="block text-xs text-neutral-500">{user.email}</span>
          ) : null}
        </Td>
        <Td>
          <div className="flex flex-wrap gap-1">
            {user.roles.length === 0 ? (
              <span className="text-xs text-neutral-400">No roles</span>
            ) : (
              user.roles.map((r) => (
                <Badge key={r} tone={r === "admin" ? "accent" : "neutral"}>
                  {roleLabel(r)}
                </Badge>
              ))
            )}
          </div>
        </Td>
        <Td>
          <Badge tone={active ? "success" : "warning"}>{active ? "Active" : "Deactivated"}</Badge>
        </Td>
        <Td>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="text-sm text-brand-700 hover:underline"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Cancel" : "Edit roles"}
            </button>
            {active ? (
              <button
                type="button"
                className="text-sm text-status-error-700 hover:underline disabled:cursor-not-allowed disabled:text-neutral-300"
                disabled={user.isSelf || setStatus.isPending}
                title={user.isSelf ? "You cannot deactivate yourself" : undefined}
                onClick={() =>
                  setStatus.mutate({ membershipId: user.membershipId, status: "suspended" })
                }
              >
                Deactivate
              </button>
            ) : (
              <button
                type="button"
                className="text-sm text-status-success-700 hover:underline disabled:opacity-50"
                disabled={setStatus.isPending}
                onClick={() =>
                  setStatus.mutate({ membershipId: user.membershipId, status: "active" })
                }
              >
                Reactivate
              </button>
            )}
          </div>
        </Td>
      </Tr>
      {editing ? (
        <Tr>
          <Td colSpan={4} className="bg-neutral-50">
            <RoleEditor
              user={user}
              saving={updateRoles.isPending}
              error={error}
              onSave={(roles) => updateRoles.mutate({ membershipId: user.membershipId, roles })}
              onCancel={() => {
                setEditing(false);
                setError(null);
              }}
            />
          </Td>
        </Tr>
      ) : null}
    </>
  );
}

function RoleEditor({
  user,
  saving,
  error,
  onSave,
  onCancel,
}: {
  user: TenantUserAdminRow;
  saving: boolean;
  error: string | null;
  onSave: (roles: InternalTenantRole[]) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(
    () =>
      new Set(
        user.roles.filter((r): r is InternalTenantRole =>
          (INTERNAL_TENANT_ROLES as readonly string[]).includes(r),
        ),
      ),
    [user.roles],
  );
  const [roles, setRoles] = useState<Set<InternalTenantRole>>(initial);

  function toggle(role: InternalTenantRole) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  // Self-demotion guard mirror: the acting admin cannot uncheck their own admin.
  const lockAdmin = user.isSelf;

  return (
    <div className="py-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {INTERNAL_TENANT_ROLES.map((role) => {
          const disabled = lockAdmin && role === "admin";
          return (
            <Checkbox
              key={role}
              checked={roles.has(role)}
              disabled={disabled}
              onCheckedChange={() => toggle(role)}
              label={roleLabel(role)}
              hint={disabled ? "Can't remove your own admin" : undefined}
            />
          );
        })}
      </div>
      {error ? <p className="mt-2 text-sm text-status-error-700">{error}</p> : null}
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => onSave([...roles])} disabled={saving || roles.size === 0}>
          {saving ? "Saving…" : "Save roles"}
        </Button>
        <button
          type="button"
          className="text-sm text-neutral-600 hover:underline"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
