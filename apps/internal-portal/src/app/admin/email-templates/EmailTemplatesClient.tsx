"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  GetEmailTemplateCatalogOutput,
  EmailTemplateCatalogEntry,
  EmailTemplateKey,
} from "@hireops/api-types";
import { Input, Switch, Button } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Email templates editor (T1.4 / G09) — tenant copy overrides.
 *
 * Left: the template list. Right: the per-template editor — a subject field and
 * one field per named slot (each showing the tokens it may reference), a live
 * preview rendered through the REAL send path, an Enabled toggle, and
 * Reset-to-default. An EMPTY field means "use the shipped default"; only a field
 * the admin fills becomes an override. Layout, styles, and data bindings are
 * fixed — the only editable things here are the subject and the named text slots.
 */

interface Draft {
  subject: string;
  slots: Record<string, string>;
  enabled: boolean;
}

function draftFromEntry(entry: EmailTemplateCatalogEntry): Draft {
  const ov = entry.override;
  return {
    subject: ov?.subjectOverride ?? "",
    slots: ov ? { ...ov.slotOverrides } : {},
    enabled: ov?.enabled ?? true,
  };
}

/** Non-empty overrides only — an empty field falls back to the shipped default. */
function draftOverrides(draft: Draft): {
  subjectOverride: string | null;
  slotOverrides: Record<string, string>;
} {
  const slotOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.slots)) {
    if (v.trim().length > 0) slotOverrides[k] = v;
  }
  const subjectOverride = draft.subject.trim().length > 0 ? draft.subject : null;
  return { subjectOverride, slotOverrides };
}

export function EmailTemplatesClient({ initial }: { initial: GetEmailTemplateCatalogOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.getEmailTemplateCatalog.useQuery(undefined, { initialData: initial });
  const templates = useMemo(() => query.data?.templates ?? [], [query.data]);

  const [selectedKey, setSelectedKey] = useState<EmailTemplateKey>(
    templates[0]?.templateKey ?? "candidate.application_received",
  );
  const selected = templates.find((t) => t.templateKey === selectedKey) ?? templates[0];

  const [draft, setDraft] = useState<Draft>(() =>
    selected ? draftFromEntry(selected) : { subject: "", slots: {}, enabled: true },
  );
  const [notice, setNotice] = useState<string | null>(null);

  // Reload the draft whenever the selected template changes (or its stored
  // override refreshes after a save/reset).
  const selectedOverrideStamp = selected?.override?.updatedAt ?? null;
  useEffect(() => {
    if (selected) setDraft(draftFromEntry(selected));
    setNotice(null);
    // Re-seed the draft when the selected template changes or its stored
    // override refreshes; `selected` is derived from these two keys.
  }, [selectedKey, selectedOverrideStamp]);

  // Debounced preview input — avoids a server render on every keystroke.
  const { subjectOverride, slotOverrides } = draftOverrides(draft);
  const [previewInput, setPreviewInput] = useState<{
    templateKey: EmailTemplateKey;
    subjectOverride?: string;
    slotOverrides?: Record<string, string>;
  }>({ templateKey: selectedKey });

  useEffect(() => {
    const handle = setTimeout(() => {
      setPreviewInput({
        templateKey: selectedKey,
        ...(subjectOverride ? { subjectOverride } : {}),
        ...(Object.keys(slotOverrides).length > 0 ? { slotOverrides } : {}),
      });
    }, 400);
    return () => clearTimeout(handle);
  }, [selectedKey, subjectOverride, JSON.stringify(slotOverrides)]);

  const preview = trpc.previewEmailTemplate.useQuery(previewInput, {
    staleTime: 0,
    retry: false,
  });

  const upsert = trpc.upsertEmailTemplateOverride.useMutation({
    onSuccess: async (res) => {
      await utils.getEmailTemplateCatalog.invalidate();
      setNotice(`Saved overrides for “${labelFor(res.row.templateKey)}”.`);
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const reset = trpc.resetEmailTemplateOverride.useMutation({
    onSuccess: async () => {
      await utils.getEmailTemplateCatalog.invalidate();
      setNotice("Reset to the shipped default copy.");
    },
    onError: (err) => {
      setNotice(`Reset failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function labelFor(key: string): string {
    return templates.find((t) => t.templateKey === key)?.label ?? key;
  }

  function onSave() {
    if (!selected) return;
    const { subjectOverride: sub, slotOverrides: slots } = draftOverrides(draft);
    upsert.mutate({
      templateKey: selected.templateKey,
      subjectOverride: sub,
      slotOverrides: slots,
      enabled: draft.enabled,
    });
  }

  function onReset() {
    if (!selected) return;
    reset.mutate({ templateKey: selected.templateKey });
  }

  const busy = upsert.isPending || reset.isPending;
  const hasStoredOverride = Boolean(selected?.override);
  const nothingEditable = selected && !selected.subject && selected.slots.length === 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <PageHeader
        title="Email templates"
        subtitle="Override the subject and the named text of each transactional email. Layout, styling, and data (names, dates, links) stay fixed — there is no raw-HTML editor. Leave a field blank to keep the shipped default."
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

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        {/* Template list */}
        <Card className="h-fit overflow-hidden p-0">
          <ul className="divide-y divide-neutral-100">
            {templates.map((t) => {
              const active = t.templateKey === selectedKey;
              return (
                <li key={t.templateKey}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(t.templateKey)}
                    className={`flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm transition-colors ${
                      active
                        ? "bg-brand-50 font-medium text-brand-800"
                        : "text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    <span className="min-w-0 truncate">{t.label}</span>
                    {t.override ? (
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          t.override.enabled
                            ? "bg-status-success-100 text-status-success-700"
                            : "bg-neutral-200 text-neutral-600"
                        }`}
                      >
                        {t.override.enabled ? "Custom" : "Off"}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Editor + preview */}
        {selected ? (
          <div className="min-w-0 space-y-6">
            <Card className="p-6">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900">{selected.label}</h2>
                  <p className="mt-0.5 text-xs text-neutral-500">{selected.description}</p>
                </div>
                {hasStoredOverride ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-neutral-500">Enabled</span>
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(next) => setDraft((d) => ({ ...d, enabled: next }))}
                      label={draft.enabled ? "On" : "Off"}
                    />
                  </div>
                ) : null}
              </div>

              {nothingEditable ? (
                <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
                  This template&apos;s copy is composed at send time (headline, body, and reason are
                  all data), so there is nothing to override here.
                </p>
              ) : (
                <div className="space-y-5">
                  {selected.subject ? (
                    <SlotField
                      label="Subject"
                      value={draft.subject}
                      placeholder={selected.subject.defaultText}
                      tokens={selected.subject.tokens}
                      note={selected.subject.note}
                      onChange={(v) => setDraft((d) => ({ ...d, subject: v }))}
                    />
                  ) : null}

                  {selected.slots.map((slot) => (
                    <SlotField
                      key={slot.slotKey}
                      label={slot.label}
                      value={draft.slots[slot.slotKey] ?? ""}
                      placeholder={slot.defaultText}
                      tokens={slot.tokens}
                      multiline
                      onChange={(v) =>
                        setDraft((d) => ({ ...d, slots: { ...d.slots, [slot.slotKey]: v } }))
                      }
                    />
                  ))}
                </div>
              )}

              {!nothingEditable ? (
                <div className="mt-6 flex items-center gap-3">
                  <Button onClick={onSave} disabled={busy}>
                    {upsert.isPending ? "Saving…" : "Save overrides"}
                  </Button>
                  <button
                    type="button"
                    onClick={onReset}
                    disabled={busy || !hasStoredOverride}
                    className="text-sm text-neutral-600 hover:underline disabled:cursor-not-allowed disabled:text-neutral-300"
                  >
                    {reset.isPending ? "Resetting…" : "Reset to default"}
                  </button>
                </div>
              ) : null}
            </Card>

            {/* Live preview — the REAL render path with sample data. */}
            <Card className="overflow-hidden p-0">
              <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  Live preview
                </p>
                <p className="mt-1 text-sm font-medium text-neutral-800">
                  Subject: {preview.data?.subject ?? "…"}
                </p>
                <p className="mt-0.5 text-xs text-neutral-400">
                  Rendered with sample data through the same path that sends real email.
                </p>
              </div>
              {preview.isError ? (
                <div className="p-4 text-sm text-status-error-700">
                  Preview failed: {preview.error.message}
                </div>
              ) : (
                <iframe
                  title="Email preview"
                  className="h-[520px] w-full bg-white"
                  sandbox=""
                  srcDoc={preview.data?.html ?? ""}
                />
              )}
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SlotField({
  label,
  value,
  placeholder,
  tokens,
  note,
  multiline,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  tokens: string[];
  note?: string;
  multiline?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      {multiline ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">{label}</span>
          <textarea
            className="min-h-[64px] w-full rounded-button border border-neutral-300 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-300"
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      ) : (
        <Input
          label={label}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <p className="mt-1 text-xs text-neutral-400">
        {tokens.length > 0 ? (
          <>
            Available tokens:{" "}
            {tokens.map((t, i) => (
              <span key={t}>
                <code className="rounded bg-neutral-100 px-1 py-0.5 text-[11px] text-neutral-600">{`{${t}}`}</code>
                {i < tokens.length - 1 ? " " : ""}
              </span>
            ))}
          </>
        ) : (
          "No data tokens — plain text only."
        )}
        {note ? <span className="ml-1 italic text-neutral-400">— {note}</span> : null}
      </p>
    </div>
  );
}
