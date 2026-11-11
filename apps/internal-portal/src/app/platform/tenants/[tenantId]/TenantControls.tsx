"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  type PlatformTenantModule,
  type TenantStatus,
} from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * C1-F10 — lifecycle + entitlement controls for one tenant. `support`
 * operators see the state read-only (the API refuses their writes too).
 */
export function TenantControls({
  tenantId,
  status,
  modules,
  canWrite,
}: {
  tenantId: string;
  status: string;
  modules: PlatformTenantModule[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [nextStatus, setNextStatus] = useState<TenantStatus>(
    (TENANT_STATUSES as readonly string[]).includes(status) ? (status as TenantStatus) : "active",
  );
  const [reason, setReason] = useState("");
  const [moduleState, setModuleState] = useState<Record<string, boolean>>(
    Object.fromEntries(modules.map((m) => [m.key, m.enabled])),
  );
  const [moduleReason, setModuleReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const setStatus = trpc.platformSetTenantStatus.useMutation({
    onSuccess: (r) => {
      setMessage(`Status changed: ${r.previousStatus} → ${r.status}.`);
      setReason("");
      router.refresh();
    },
    onError: (e) => setMessage(e.message),
  });
  const setModules = trpc.platformSetTenantModules.useMutation({
    onSuccess: (r) => {
      setMessage(
        r.changed.length === 0
          ? "No module changes."
          : `Modules updated: ${r.changed.map((c) => `${c.key} ${c.enabled ? "on" : "off"}`).join(", ")}.`,
      );
      setModuleReason("");
      router.refresh();
    },
    onError: (e) => setMessage(e.message),
  });

  const dirtyModules = modules
    .filter((m) => moduleState[m.key] !== m.enabled)
    .map((m) => ({ key: m.key, enabled: Boolean(moduleState[m.key]) }));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <h2 className="mb-3 text-sm font-semibold">Lifecycle</h2>
        <p className="mb-3 text-xs text-neutral-500">
          Anything but Active blocks sign-in, every API call and all background work for this tenant
          (internal users, partners and candidates). Takes effect within a minute.
        </p>
        <div className="flex flex-col gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">Status</span>
            <select
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={nextStatus}
              disabled={!canWrite}
              onChange={(e) => setNextStatus(e.target.value as TenantStatus)}
            >
              {TENANT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TENANT_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-neutral-700">Reason (required, audited)</span>
            <input
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              value={reason}
              disabled={!canWrite}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div>
            <Button
              variant={nextStatus === "active" ? "primary" : "danger"}
              size="sm"
              disabled={
                !canWrite ||
                reason.trim().length < 3 ||
                nextStatus === status ||
                setStatus.isPending
              }
              onClick={() => setStatus.mutate({ tenantId, status: nextStatus, reason })}
            >
              Apply status
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Modules</h2>
        <p className="mb-3 text-xs text-neutral-500">
          A switched-off module is hidden from the tenant&apos;s navigation, refused by the API and
          skipped by background workers. &quot;default&quot; means no explicit setting (on).
        </p>
        <ul className="mb-3 divide-y divide-neutral-100">
          {modules.map((m) => (
            <li key={m.key} className="flex items-center justify-between py-1.5 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(moduleState[m.key])}
                  disabled={!canWrite}
                  onChange={(e) => setModuleState((s) => ({ ...s, [m.key]: e.target.checked }))}
                />
                <span>{m.label}</span>
              </label>
              <span className="text-xs text-neutral-400">{m.explicit ? m.key : "default"}</span>
            </li>
          ))}
        </ul>
        <input
          className="mb-3 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          placeholder="Reason (optional, audited)"
          value={moduleReason}
          disabled={!canWrite}
          maxLength={500}
          onChange={(e) => setModuleReason(e.target.value)}
        />
        <Button
          size="sm"
          disabled={!canWrite || dirtyModules.length === 0 || setModules.isPending}
          onClick={() =>
            setModules.mutate({
              tenantId,
              modules: dirtyModules,
              ...(moduleReason.trim() ? { reason: moduleReason.trim() } : {}),
            })
          }
        >
          Save modules
        </Button>
      </Card>

      {!canWrite ? (
        <p className="text-xs text-neutral-500">Your platform role is read-only (support).</p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-neutral-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}
