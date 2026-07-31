"use client";

import { PageContainer } from "@/components/nav/PageContainer";
import { useMemo, useState } from "react";
import {
  defaultIrisPolicy,
  type GetIrisPolicyOutput,
  type IrisActionMenuItem,
  type IrisPolicy,
} from "@hireops/api-types";
import { Switch, Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin per-role Iris action policy editor (T-POLICY).
 *
 * A DENY-OVERLAY matrix: one row per whitelisted Iris action, one column per
 * role (the union of roles across the catalog, derived dynamically). A cell is a
 * live toggle only when the role is in that action's static roles; otherwise it
 * shows a muted dash (the role could never run the action, so there is nothing
 * to disable). ON = the action stays available to that role; turning a cell OFF
 * adds the role to `disabledRoles[actionId]`, removing that action from Iris for
 * that role.
 *
 * HONEST NARROWING: the overlay can only ever NARROW the baked-in static roles,
 * never widen them. An unconfigured tenant (empty overlay) is byte-identical to
 * the default behaviour: every action available to its default roles.
 */

/** Strip out any empty disabled-role arrays so the stored block stays minimal. */
function prunePolicy(policy: IrisPolicy): IrisPolicy {
  const disabledRoles: Record<string, string[]> = {};
  for (const [actionId, roles] of Object.entries(policy.disabledRoles)) {
    if (roles.length > 0) disabledRoles[actionId] = [...roles].sort();
  }
  return { version: policy.version, disabledRoles };
}

export function IrisPolicyClient({ initial }: { initial: GetIrisPolicyOutput }) {
  const actions = initial.actions;
  const [draft, setDraft] = useState<IrisPolicy>(() => prunePolicy(initial.policy));
  const [saved, setSaved] = useState<IrisPolicy>(() => prunePolicy(initial.policy));
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateIrisPolicy.useMutation({
    onSuccess: (res) => {
      const pruned = prunePolicy(res.policy);
      setDraft(pruned);
      setSaved(pruned);
      setNotice("Iris policy saved. It applies to every Iris action immediately.");
    },
    onError: (err) => setNotice(`Save failed: ${err.message}`),
  });

  // Column set: the UNION of roles across the whole catalog, derived (never
  // hardcoded) so a new action role automatically gets a column.
  const roleColumns = useMemo(() => {
    const set = new Set<string>();
    for (const a of actions) for (const r of a.roles) set.add(r);
    return [...set].sort();
  }, [actions]);

  const dirty = useMemo(
    () => JSON.stringify(prunePolicy(draft)) !== JSON.stringify(saved),
    [draft, saved],
  );

  function isEnabled(action: IrisActionMenuItem, role: string): boolean {
    return !(draft.disabledRoles[action.id] ?? []).includes(role);
  }

  function toggle(action: IrisActionMenuItem, role: string, enabled: boolean) {
    setDraft((prev) => {
      const current = new Set(prev.disabledRoles[action.id] ?? []);
      if (enabled) current.delete(role);
      else current.add(role);
      // Rebuild WITHOUT this action's key when its overlay is now empty, so the
      // stored block never carries an empty array (avoids a dynamic delete).
      const next: Record<string, string[]> = {};
      for (const [id, roles] of Object.entries(prev.disabledRoles)) {
        if (id !== action.id && roles.length > 0) next[id] = roles;
      }
      if (current.size > 0) next[action.id] = [...current];
      return { version: prev.version, disabledRoles: next };
    });
  }

  const disabledCount = useMemo(
    () => Object.values(draft.disabledRoles).reduce((acc, r) => acc + r.length, 0),
    [draft],
  );

  return (
    <PageContainer variant="measure" className="pb-10">
      <Card className="p-5">
        <div className="mb-1 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-neutral-900">Iris action policy</h2>
          <Badge tone={disabledCount > 0 ? "warning" : "neutral"}>
            {disabledCount} {disabledCount === 1 ? "restriction" : "restrictions"}
          </Badge>
        </div>
        <p className="mb-1 text-xs text-neutral-600">
          Control which roles may run each Iris action. Unconfigured, every action is available to
          its default roles; turning a cell off removes that action from Iris for that role.
        </p>
        <p className="mb-4 text-xs text-neutral-500">
          This can only narrow access, never widen it. A dash means the role could never run that
          action, so there is nothing to turn off. The action&apos;s own permission checks still
          apply on top of this policy.
        </p>

        {notice ? (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              notice.startsWith("Save failed")
                ? "border-status-error-200 bg-status-error-50 text-status-error-700"
                : "border-status-success-200 bg-status-success-50 text-status-success-700"
            }`}
          >
            {notice}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200">
                <th className="py-2 pr-4 text-left text-xs font-semibold text-neutral-500">
                  Action
                </th>
                {roleColumns.map((role) => (
                  <th
                    key={role}
                    className="px-3 py-2 text-center text-xs font-semibold text-neutral-500"
                  >
                    {role}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => (
                <tr key={action.id} className="border-b border-neutral-100">
                  <td className="py-3 pr-4 align-top">
                    <p className="text-sm font-medium text-neutral-800">{action.label}</p>
                    <p className="text-xs text-neutral-500">{action.group}</p>
                  </td>
                  {roleColumns.map((role) => {
                    const applicable = action.roles.includes(role);
                    return (
                      <td key={role} className="px-3 py-3 text-center align-middle">
                        {applicable ? (
                          <Switch
                            className="items-center"
                            checked={isEnabled(action, role)}
                            onCheckedChange={(checked) => toggle(action, role, checked)}
                          />
                        ) : (
                          <span className="text-neutral-300" aria-hidden>
                            &ndash;
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <Button
            onClick={() => update.mutate({ policy: prunePolicy(draft) })}
            disabled={!dirty || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save policy"}
          </Button>
          {dirty ? (
            <button
              type="button"
              className="text-sm text-neutral-600 hover:underline"
              onClick={() => {
                setDraft(saved);
                setNotice(null);
              }}
            >
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            className="ml-auto text-xs text-neutral-500 hover:underline"
            onClick={() => setDraft(defaultIrisPolicy())}
          >
            Reset to defaults
          </button>
        </div>
      </Card>
    </PageContainer>
  );
}
