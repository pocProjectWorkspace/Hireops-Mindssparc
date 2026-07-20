"use client";

import { useMemo, useState } from "react";
import type {
  ApplicationSource,
  IngestionMode,
  ListTenantSourcesOutput,
  TenantSourceRow,
} from "@hireops/api-types";
import { Input, Select, Switch, Button } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Sources editor (T1.1 / G04) — the sourcing-channel registry.
 *
 * A table of the tenant's configured channels + an add/edit panel. Everything
 * is REAL config: enabling/disabling and relabelling flow through to the
 * recruiter source surfaces (the Candidates filter + column read these labels).
 *
 * HONESTY — the ingestion-mode column never claims a channel auto-pulls. A
 * "Connector (work package)" channel is CONFIGURED, not live; the copy says so.
 * The only channels that actually ingest today do it through the existing
 * portal/manual flows (the public career-site apply form, partner submissions,
 * recruiter-entered attribution).
 */

// The canonical taxonomy (application_source enum) + platform default labels.
// The registry is CONFIG over this fixed list — an admin can relabel/disable,
// never invent a new enum value.
const SOURCE_ORDER: { value: ApplicationSource; defaultLabel: string; detailHint: string }[] = [
  {
    value: "career_site",
    defaultLabel: "Career site",
    detailHint: "Career-site slug (e.g. careers)",
  },
  { value: "referral", defaultLabel: "Referral", detailHint: "Referral programme name" },
  { value: "partner_empanelled", defaultLabel: "Partner", detailHint: "Partner portal reference" },
  {
    value: "partner_adhoc",
    defaultLabel: "Partner (ad-hoc)",
    detailHint: "Intake mailbox address",
  },
  {
    value: "job_board",
    defaultLabel: "Job board",
    detailHint: "Job-board name (LinkedIn, Naukri…)",
  },
  { value: "agency_search", defaultLabel: "Agency search", detailHint: "Agency / desk name" },
  { value: "talent_pool", defaultLabel: "Talent pool", detailHint: "Pool / segment name" },
  { value: "whatsapp", defaultLabel: "WhatsApp", detailHint: "WhatsApp business number" },
];

const INGESTION_OPTIONS: { value: IngestionMode; label: string }[] = [
  { value: "manual", label: "Manual / portal" },
  { value: "connector_pending", label: "Connector (work package)" },
];

function defaultLabelFor(source: ApplicationSource): string {
  return SOURCE_ORDER.find((s) => s.value === source)?.defaultLabel ?? source;
}
function detailHintFor(source: ApplicationSource): string {
  return SOURCE_ORDER.find((s) => s.value === source)?.detailHint ?? "Channel detail";
}

interface FormState {
  sourceEnum: ApplicationSource;
  label: string;
  enabled: boolean;
  ingestionMode: IngestionMode;
  detail: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  sourceEnum: "career_site",
  label: "",
  enabled: true,
  ingestionMode: "manual",
  detail: "",
  notes: "",
};

export function SourcesClient({ initial }: { initial: ListTenantSourcesOutput }) {
  const query = trpc.listTenantSources.useQuery(undefined, { initialData: initial });
  const rows = query.data?.rows ?? [];

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const upsert = trpc.upsertTenantSource.useMutation({
    onSuccess: async (res) => {
      await query.refetch();
      setNotice(`Saved “${res.row.label}”.`);
      resetForm();
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const toggle = trpc.setTenantSourceEnabled.useMutation({
    onSuccess: async (res) => {
      await query.refetch();
      setNotice(`“${res.row.label}” is now ${res.row.enabled ? "enabled" : "disabled"}.`);
    },
    onError: (err) => {
      setNotice(`Update failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  // Channels not yet configured — the choices when ADDING a new registry row.
  const availableToAdd = useMemo(() => {
    const configured = new Set(rows.map((r) => r.sourceEnum));
    return SOURCE_ORDER.filter((s) => !configured.has(s.value));
  }, [rows]);

  const isEditing = editingId !== null;
  const trimmedLabel = form.label.trim();
  const labelValid = trimmedLabel.length >= 1 && trimmedLabel.length <= 80;
  const busy = upsert.isPending;

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(row: TenantSourceRow) {
    setEditingId(row.id);
    setForm({
      sourceEnum: row.sourceEnum,
      label: row.label,
      enabled: row.enabled,
      ingestionMode: row.ingestionMode,
      detail: typeof row.config.detail === "string" ? row.config.detail : "",
      notes: row.notes ?? "",
    });
    setNotice(null);
  }

  function startAdd() {
    const first = availableToAdd[0]?.value ?? "career_site";
    setEditingId(null);
    setForm({ ...EMPTY_FORM, sourceEnum: first, label: defaultLabelFor(first) });
    setNotice(null);
  }

  function onSave() {
    if (!labelValid) return;
    const detail = form.detail.trim();
    const notes = form.notes.trim();
    upsert.mutate({
      sourceEnum: form.sourceEnum,
      label: trimmedLabel,
      enabled: form.enabled,
      ingestionMode: form.ingestionMode,
      config: detail === "" ? {} : { detail },
      notes: notes === "" ? null : notes,
    });
  }

  const formOpen = isEditing || form.label !== "" || query.data?.rows.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Sourcing channels"
        subtitle="Declare which channels feed this tenant's pipeline, what to call them, and whether they're on. Labels flow through to the recruiter source views."
        right={
          availableToAdd.length > 0 ? <Button onClick={startAdd}>Add channel</Button> : undefined
        }
      />

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.includes("failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      {/* Honesty banner — config vs ingestion. */}
      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        Configuring a channel here declares and labels it — it does not connect an automated pull.
        Candidates arrive today via the existing portal and manual flows. Channels marked{" "}
        <span className="font-medium">Connector (work package)</span> are configured; their
        automated ingestion is a separate connector work package.
      </div>

      {/* Registry table */}
      <Card className="mt-6 overflow-hidden p-0">
        {rows.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-neutral-800">No channels configured yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              Add a channel to start declaring how candidates reach this tenant&apos;s pipeline.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50/60 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                <th className="px-4 py-2.5">Channel</th>
                <th className="px-4 py-2.5">Taxonomy value</th>
                <th className="px-4 py-2.5">Ingestion</th>
                <th className="px-4 py-2.5">Enabled</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-neutral-900">{row.label}</div>
                    {row.notes ? (
                      <div className="mt-0.5 text-xs text-neutral-500">{row.notes}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                      {row.sourceEnum}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    {row.ingestionMode === "connector_pending" ? (
                      <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                        Connector (work package)
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-600">
                        Manual / portal
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Switch
                      checked={row.enabled}
                      onCheckedChange={(next) => toggle.mutate({ id: row.id, enabled: next })}
                      disabled={toggle.isPending}
                      label={row.enabled ? "On" : "Off"}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      className="text-sm font-medium text-brand-600 hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Add / edit panel */}
      {formOpen ? (
        <Card className="mt-6 p-6">
          <h2 className="mb-4 text-sm font-semibold text-neutral-900">
            {isEditing ? "Edit channel" : "Add channel"}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-sm font-medium text-neutral-700">Channel</span>
              {isEditing ? (
                <div className="flex h-10 items-center rounded-button border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-600">
                  <code className="text-xs">{form.sourceEnum}</code>
                  <span className="ml-2 text-neutral-400">(taxonomy value is fixed)</span>
                </div>
              ) : (
                <Select
                  options={availableToAdd.map((s) => ({
                    value: s.value,
                    label: `${s.defaultLabel} (${s.value})`,
                  }))}
                  value={form.sourceEnum}
                  onValueChange={(v) => {
                    const next = v as ApplicationSource;
                    setForm((f) => ({
                      ...f,
                      sourceEnum: next,
                      label: f.label.trim() === "" ? defaultLabelFor(next) : f.label,
                    }));
                  }}
                  placeholder="Pick a channel"
                />
              )}
            </div>

            <Input
              label="Display label"
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              maxLength={80}
              required
              error={!labelValid && form.label.length > 0 ? "A label is required" : undefined}
              placeholder={defaultLabelFor(form.sourceEnum)}
            />

            <div>
              <span className="mb-1 block text-sm font-medium text-neutral-700">
                Ingestion mode
              </span>
              <Select
                options={INGESTION_OPTIONS}
                value={form.ingestionMode}
                onValueChange={(v) => setForm((f) => ({ ...f, ingestionMode: v as IngestionMode }))}
              />
              <p className="mt-1 text-xs text-neutral-500">
                {form.ingestionMode === "connector_pending"
                  ? "Configured only — the automated pull is a deferred connector work package."
                  : "Candidates enter via the existing portal / manual flows."}
              </p>
            </div>

            <Input
              label="Channel detail (optional)"
              value={form.detail}
              onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))}
              maxLength={200}
              hint="Stored as config; no connector reads it yet."
              placeholder={detailHintFor(form.sourceEnum)}
            />

            <div className="sm:col-span-2">
              <Input
                label="Notes (optional)"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                maxLength={500}
                placeholder="Internal note about how this channel is used"
              />
            </div>

            <div className="flex items-center justify-between gap-4 sm:col-span-2">
              <div>
                <p className="text-sm font-medium text-neutral-800">Enabled</p>
                <p className="text-xs text-neutral-500">
                  Disabled channels are hidden from the recruiter source filters.
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(next) => setForm((f) => ({ ...f, enabled: next }))}
                label={form.enabled ? "On" : "Off"}
              />
            </div>
          </div>

          <div className="mt-6 flex items-center gap-3">
            <Button onClick={onSave} disabled={!labelValid || busy}>
              {busy ? "Saving…" : isEditing ? "Save changes" : "Add channel"}
            </Button>
            <button
              type="button"
              className="text-sm text-neutral-600 hover:underline"
              onClick={resetForm}
            >
              Cancel
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
