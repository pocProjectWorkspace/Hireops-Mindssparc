"use client";

import { useMemo, useState } from "react";
import {
  BIAS_CATEGORIES,
  BIAS_CATEGORY_META,
  BIAS_ENFORCEMENT_MODES,
  BIAS_SEVERITIES,
  defaultBiasEntries,
  type BiasCategory,
  type BiasEnforcementMode,
  type BiasLexicon,
  type BiasLexiconEntry,
  type BiasSeverity,
} from "@hireops/api-types";
import { Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin JD bias gate editor (CONF-02). One section on /admin/ai-settings:
 * the enforcement mode + the editable lexicon table (add / edit / remove /
 * reset-to-default), saved as one updateTenantBiasLexicon mutation (admin-
 * only, audited, merged into tenants.settings alongside — never over —
 * aiSettings). Honest copy: this is a language-hygiene aid, not a fairness
 * claim, and there is no demographic analysis anywhere.
 */

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

const ENFORCEMENT_COPY: Record<BiasEnforcementMode, string> = {
  off: "No gate. Submissions proceed and nothing is recorded.",
  warn: "Submissions always proceed; any flagged language is recorded for the HR head to see.",
  block: "Terms marked 'block' stop a submission until revised; 'warn' terms are only recorded.",
};

interface Row extends BiasLexiconEntry {
  key: string;
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

function toRows(entries: BiasLexiconEntry[]): Row[] {
  return entries.map((e) => ({ ...e, key: uid() }));
}

export function BiasLexiconClient({ initialLexicon }: { initialLexicon: BiasLexicon }) {
  const [enforcement, setEnforcement] = useState<BiasEnforcementMode>(initialLexicon.enforcement);
  const [rows, setRows] = useState<Row[]>(toRows(initialLexicon.entries));
  const [saved, setSaved] = useState<string>(
    JSON.stringify({ enforcement: initialLexicon.enforcement, entries: initialLexicon.entries }),
  );
  const [notice, setNotice] = useState<string | null>(null);

  const currentEntries = useMemo<BiasLexiconEntry[]>(
    () =>
      rows.map((r) => ({
        term: r.term,
        category: r.category,
        severity: r.severity,
        ...(r.suggestion ? { suggestion: r.suggestion } : {}),
      })),
    [rows],
  );

  const dirty = useMemo(
    () => JSON.stringify({ enforcement, entries: currentEntries }) !== saved,
    [enforcement, currentEntries, saved],
  );

  const update = trpc.updateTenantBiasLexicon.useMutation({
    onSuccess: (res) => {
      setEnforcement(res.lexicon.enforcement);
      setRows(toRows(res.lexicon.entries));
      setSaved(
        JSON.stringify({ enforcement: res.lexicon.enforcement, entries: res.lexicon.entries }),
      );
      setNotice("Bias gate saved. New submissions use it immediately.");
    },
    onError: (err) => setNotice(`Save failed: ${err.message}`),
  });

  function patchRow(key: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function onSave() {
    const cleaned = currentEntries.filter((e) => e.term.trim().length > 0);
    update.mutate({ version: 1, enforcement, entries: cleaned });
  }

  function onReset() {
    setEnforcement("warn");
    setRows(toRows(defaultBiasEntries()));
    setNotice(null);
  }

  const blockCount = rows.filter((r) => r.severity === "block").length;

  return (
    <div className="mx-auto mt-2 w-full max-w-3xl px-6 pb-10">
      <div className="mb-4 border-t border-neutral-200 pt-8">
        <h2 className="text-base font-semibold text-neutral-900">JD bias gate</h2>
        <p className="mt-1 text-sm text-neutral-600">
          A deterministic inclusive-language scan over the requisition JD, run in the wizard (live)
          and again at submit. This is a language-hygiene aid — it flags coded wording from the
          lexicon below. It makes no demographic or fairness inference about any candidate.
        </p>
      </div>

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

      <Card className="mb-4 p-5">
        <h3 className="mb-2 text-sm font-semibold text-neutral-900">Enforcement</h3>
        <div className="flex flex-wrap gap-2">
          {BIAS_ENFORCEMENT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setEnforcement(mode)}
              className={`rounded-button border px-3 py-1.5 text-sm capitalize ${
                enforcement === mode
                  ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
                  : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-500">{ENFORCEMENT_COPY[enforcement]}</p>
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-900">Lexicon</h3>
            <Badge tone="neutral">{rows.length} terms</Badge>
            {blockCount > 0 ? <Badge tone="error">{blockCount} block</Badge> : null}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs text-neutral-600 hover:underline"
              onClick={onReset}
            >
              Reset to default
            </button>
            <button
              type="button"
              className="text-xs text-brand-600 hover:underline"
              onClick={() =>
                setRows((rs) => [
                  { key: uid(), term: "", category: "gendered", severity: "warn" },
                  ...rs,
                ])
              }
            >
              + Add term
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.key}
              className="grid grid-cols-12 items-start gap-2 rounded-lg border border-neutral-200 p-2"
            >
              <div className="col-span-3">
                <input
                  className={inputCls}
                  value={r.term}
                  placeholder="rockstar"
                  onChange={(e) => patchRow(r.key, { term: e.target.value })}
                />
              </div>
              <div className="col-span-3">
                <select
                  className={inputCls}
                  value={r.category}
                  onChange={(e) => patchRow(r.key, { category: e.target.value as BiasCategory })}
                >
                  {BIAS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {BIAS_CATEGORY_META[c].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <select
                  className={inputCls}
                  value={r.severity}
                  onChange={(e) => patchRow(r.key, { severity: e.target.value as BiasSeverity })}
                >
                  {BIAS_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-3">
                <input
                  className={inputCls}
                  value={r.suggestion ?? ""}
                  placeholder="Inclusive rewrite (optional)"
                  onChange={(e) => patchRow(r.key, { suggestion: e.target.value })}
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <button
                  type="button"
                  className="mt-1.5 text-xs text-status-error-600 hover:underline"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {rows.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No terms — the gate will flag nothing. Add terms or reset to the default lexicon.
            </p>
          ) : null}
        </div>
      </Card>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onSave} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save bias gate"}
        </Button>
        {dirty ? (
          <button
            type="button"
            className="text-sm text-neutral-600 hover:underline"
            onClick={() => {
              const parsed = JSON.parse(saved) as {
                enforcement: BiasEnforcementMode;
                entries: BiasLexiconEntry[];
              };
              setEnforcement(parsed.enforcement);
              setRows(toRows(parsed.entries));
              setNotice(null);
            }}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </div>
  );
}
