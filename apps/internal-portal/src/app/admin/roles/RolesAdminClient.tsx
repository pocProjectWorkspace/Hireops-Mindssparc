"use client";

import { useMemo, useState } from "react";
import {
  CAPABILITY_AREAS,
  CAPABILITY_AREA_LABELS,
  CAPABILITY_SCOPE_LABELS,
  CUSTOM_ROLE_BASE_ROLES,
  type CapabilityCatalogEntry,
  type CapabilityGrant,
  type CapabilityScope,
  type ListRolesOutput,
  type RoleRow,
} from "@hireops/api-types";
import { Button, Checkbox } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import { useRoleLabel } from "@/lib/role-labels";
import { trpc } from "@/lib/trpc-client";

/**
 * C2-F1 — Roles & permissions admin. Lists system roles (read-only) and custom
 * roles; creates / edits a custom role (label, base role, capability checkboxes
 * grouped by area, scope dropdown where the capability has a target
 * population); deactivates one nobody holds. The API refuses grants the acting
 * admin doesn't hold themselves (no privilege escalation).
 */

const inputCls =
  "h-9 rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

interface Draft {
  key: string;
  label: string;
  baseRole: (typeof CUSTOM_ROLE_BASE_ROLES)[number];
  description: string;
  grants: Map<string, CapabilityScope>;
  isNew: boolean;
}

function draftFrom(role: RoleRow | null): Draft {
  if (!role) {
    return {
      key: "",
      label: "",
      baseRole: "recruiter",
      description: "",
      // Home (the landing dashboard) is on by default; untick to remove it.
      grants: new Map<string, CapabilityScope>([["dashboard.view", "all"]]),
      isNew: true,
    };
  }
  return {
    key: role.isSystem ? "" : role.key,
    label: role.isSystem ? `${role.label} (custom)` : role.label,
    baseRole: (CUSTOM_ROLE_BASE_ROLES as readonly string[]).includes(role.baseRole)
      ? (role.baseRole as Draft["baseRole"])
      : "recruiter",
    description: role.isSystem ? "" : (role.description ?? ""),
    grants: new Map(role.grants.map((g) => [g.capability, g.scope])),
    isNew: role.isSystem,
  };
}

export function RolesAdminClient({ initial }: { initial: ListRolesOutput }) {
  const utils = trpc.useUtils();
  const rolesQuery = trpc.listRoles.useQuery({}, { initialData: initial });
  const data = rolesQuery.data ?? initial;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roleLabel = useRoleLabel();

  const refresh = () => utils.listRoles.invalidate();
  const setActive = trpc.setCustomRoleActive.useMutation({
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => setError(err.message),
  });

  const system = data.roles.filter((r) => r.isSystem);
  const custom = data.roles.filter((r) => !r.isSystem);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
          Roles &amp; permissions
        </h1>
        <p className="mt-1 max-w-prose text-sm text-neutral-500">
          A role is a name and a set of permissions over a base role. System roles follow the
          platform defaults and can&apos;t be edited; copy one to start a custom role. Assign roles
          to people on Users &amp; roles. Changes apply within a minute, without signing out.
        </p>
      </div>

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-3 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}
      {error ? <p className="mb-4 text-sm text-status-error-700">{error}</p> : null}

      {draft ? (
        <RoleEditor
          draft={draft}
          catalog={data.catalog}
          onCancel={() => setDraft(null)}
          onSaved={(msg) => {
            setDraft(null);
            setNotice(msg);
            void refresh();
          }}
        />
      ) : (
        <Button variant="secondary" onClick={() => setDraft(draftFrom(null))}>
          New custom role
        </Button>
      )}

      <h2 className="mt-8 text-sm font-semibold text-neutral-900">Custom roles</h2>
      {custom.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No custom roles yet.</p>
      ) : (
        <div className="mt-2 grid gap-3">
          {custom.map((r) => (
            <RoleCard
              key={r.key}
              role={r}
              baseLabel={roleLabel(r.baseRole)}
              actions={
                <>
                  <button
                    type="button"
                    className="text-sm text-brand-700 hover:underline"
                    onClick={() => setDraft(draftFrom(r))}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-sm text-neutral-600 hover:underline disabled:opacity-50"
                    disabled={setActive.isPending}
                    onClick={() => setActive.mutate({ key: r.key, active: !r.active })}
                  >
                    {r.active ? "Deactivate" : "Reactivate"}
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}

      <h2 className="mt-8 text-sm font-semibold text-neutral-900">System roles</h2>
      <div className="mt-2 grid gap-3">
        {system.map((r) => (
          <RoleCard
            key={r.key}
            role={{ ...r, label: roleLabel(r.key) }}
            baseLabel={roleLabel(r.baseRole)}
            actions={
              <button
                type="button"
                className="text-sm text-brand-700 hover:underline"
                onClick={() => setDraft(draftFrom(r))}
              >
                Copy to a custom role
              </button>
            }
          />
        ))}
      </div>
    </div>
  );
}

function RoleCard({
  role,
  baseLabel,
  actions,
}: {
  role: RoleRow;
  baseLabel: string;
  actions: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-neutral-900">
            {role.label}{" "}
            {role.isSystem ? (
              <Badge tone="neutral">System</Badge>
            ) : (
              <Badge tone={role.active ? "accent" : "warning"}>
                {role.active ? "Custom" : "Deactivated"}
              </Badge>
            )}
          </p>
          <p className="text-xs text-neutral-500">
            {role.isSystem ? null : <>Base role {baseLabel} · </>}
            {role.grants.length} permissions · {role.memberCount}{" "}
            {role.memberCount === 1 ? "member" : "members"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-sm text-neutral-600 hover:underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide permissions" : "Show permissions"}
          </button>
          {actions}
        </div>
      </div>
      {open ? (
        <ul className="mt-3 grid gap-1 text-xs text-neutral-700 sm:grid-cols-2">
          {role.grants.map((g) => (
            <li key={g.capability}>
              <code>{g.capability}</code>
              {g.scope !== "all" ? (
                <span className="text-neutral-500"> · {CAPABILITY_SCOPE_LABELS[g.scope]}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function RoleEditor({
  draft: initialDraft,
  catalog,
  onCancel,
  onSaved,
}: {
  draft: Draft;
  catalog: CapabilityCatalogEntry[];
  onCancel: () => void;
  onSaved: (msg: string) => void;
}) {
  const roleLabel = useRoleLabel();
  const [d, setD] = useState<Draft>(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const save = trpc.upsertCustomRole.useMutation({
    onSuccess: (res) => onSaved(`${res.created ? "Created" : "Saved"} ${res.role.label}.`),
    onError: (err) => setError(err.message),
  });

  const byArea = useMemo(() => {
    const m = new Map<string, CapabilityCatalogEntry[]>();
    for (const c of catalog) m.set(c.area, [...(m.get(c.area) ?? []), c]);
    return m;
  }, [catalog]);

  function toggle(c: CapabilityCatalogEntry) {
    setD((prev) => {
      const grants = new Map(prev.grants);
      if (grants.has(c.key)) grants.delete(c.key);
      else grants.set(c.key, "all");
      return { ...prev, grants };
    });
  }
  function setScope(cap: string, scope: CapabilityScope) {
    setD((prev) => {
      const grants = new Map(prev.grants);
      grants.set(cap, scope);
      return { ...prev, grants };
    });
  }

  function submit() {
    const grants: CapabilityGrant[] = [...d.grants.entries()].map(([capability, scope]) => ({
      capability: capability as CapabilityGrant["capability"],
      scope,
    }));
    save.mutate({
      key: d.key.trim(),
      label: d.label.trim(),
      baseRole: d.baseRole,
      description: d.description.trim() || null,
      grants,
    });
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-neutral-900">
        {d.isNew ? "New custom role" : `Edit ${d.label}`}
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-neutral-700">
          Name
          <input
            className={inputCls}
            value={d.label}
            maxLength={60}
            onChange={(e) => setD({ ...d, label: e.target.value })}
            placeholder="e.g. TA lead"
          />
        </label>
        <label className="grid gap-1 text-sm text-neutral-700">
          Key
          <input
            className={inputCls}
            value={d.key}
            disabled={!d.isNew}
            maxLength={48}
            onChange={(e) => setD({ ...d, key: e.target.value })}
            placeholder="e.g. ta_lead"
          />
          <span className="text-xs text-neutral-500">
            Lowercase letters, digits and underscores. Can&apos;t be changed later.
          </span>
        </label>
        <label className="grid gap-1 text-sm text-neutral-700">
          Base role
          <select
            className={inputCls}
            value={d.baseRole}
            onChange={(e) => setD({ ...d, baseRole: e.target.value as Draft["baseRole"] })}
          >
            {CUSTOM_ROLE_BASE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-500">
            Decides the member&apos;s persona (home page, onboarding tour) and their database role.
            Permissions come only from the boxes below.
          </span>
        </label>
        <label className="grid gap-1 text-sm text-neutral-700">
          Description
          <input
            className={inputCls}
            value={d.description}
            maxLength={400}
            onChange={(e) => setD({ ...d, description: e.target.value })}
          />
        </label>
      </div>

      <div className="mt-5 grid gap-5">
        {CAPABILITY_AREAS.map((area) => {
          const caps = byArea.get(area) ?? [];
          if (caps.length === 0) return null;
          return (
            <fieldset key={area}>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {CAPABILITY_AREA_LABELS[area]}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {caps.map((c) => {
                  const scope = d.grants.get(c.key);
                  return (
                    <div key={c.key} className="flex flex-wrap items-start gap-2">
                      <Checkbox
                        checked={scope !== undefined}
                        onCheckedChange={() => toggle(c)}
                        label={c.label}
                        hint={c.description}
                      />
                      {scope !== undefined && c.scopes.length > 1 ? (
                        <select
                          className={`${inputCls} h-8 text-xs`}
                          aria-label={`Scope for ${c.label}`}
                          title={c.scopeNote ?? undefined}
                          value={scope}
                          onChange={(e) => setScope(c.key, e.target.value as CapabilityScope)}
                        >
                          {c.scopes.map((s) => (
                            <option key={s} value={s}>
                              {CAPABILITY_SCOPE_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>

      {error ? <p className="mt-3 text-sm text-status-error-700">{error}</p> : null}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={submit} disabled={save.isPending || !d.label.trim() || !d.key.trim()}>
          {save.isPending ? "Saving…" : "Save role"}
        </Button>
        <button
          type="button"
          className="text-sm text-neutral-600 hover:underline"
          onClick={onCancel}
        >
          Cancel
        </button>
        <span className="text-xs text-neutral-500">{d.grants.size} permissions selected</span>
      </div>
    </Card>
  );
}
