"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_ROLE_LABELS,
  ROLE_LABEL_KEYS,
  ROLE_LABEL_MAX_CHARS,
  roleLabelOverridesOf,
  type RoleLabelKey,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Role display names (PC-23). Lets an admin rename how a role READS across
 * the portal (user chip, this page, role pickers) — e.g. "HR Head" → "TA
 * Lead". Keys and permissions never change; a blank field reverts the role to
 * the platform default. Collapsed by default, like "Invite a member".
 */
export function RoleLabelsPanel({ onSaved }: { onSaved: (msg: string) => void }) {
  const utils = trpc.useUtils();
  const query = trpc.getRoleLabels.useQuery({}, { staleTime: 5 * 60 * 1000 });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<RoleLabelKey, string>>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setDraft(query.data.overrides);
  }, [query.data]);

  const save = trpc.updateRoleLabels.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.getRoleLabels.invalidate();
      onSaved("Role display names saved.");
      setOpen(false);
    },
    onError: (err) => setError(err.message),
  });

  if (!open) {
    return (
      <Button variant="secondary" className="ml-2" onClick={() => setOpen(true)}>
        Role display names
      </Button>
    );
  }

  return (
    <Card className="mt-4 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">Role display names</h2>
        <button
          type="button"
          className="text-sm text-neutral-500 hover:underline"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
      <p className="mb-4 max-w-prose text-xs text-neutral-500">
        Rename how a role appears in this workspace. Only the name changes: what each role can see
        and do stays exactly the same. Leave a field blank to use the default name.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ROLE_LABEL_KEYS.map((key) => (
          <Input
            key={key}
            label={DEFAULT_ROLE_LABELS[key]}
            value={draft[key] ?? ""}
            placeholder={DEFAULT_ROLE_LABELS[key]}
            maxLength={ROLE_LABEL_MAX_CHARS}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          />
        ))}
      </div>
      {error ? <p className="mt-3 text-sm text-status-error-700">{error}</p> : null}
      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() => save.mutate({ overrides: roleLabelOverridesOf(draft) })}
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save names"}
        </Button>
        <Button variant="secondary" onClick={() => setDraft({})} disabled={save.isPending}>
          Reset all to defaults
        </Button>
      </div>
    </Card>
  );
}
