"use client";

import { useMemo, useState } from "react";
import type {
  GetRetentionPolicyOutput,
  GetDocumentRetentionOutput,
  ListDocumentsPastRetentionOutput,
  UpdateRetentionPolicyInput,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin document-retention editor (T4.3) — the per-document-type retention config
 * + the honest "documents past retention" register.
 *
 * The editor is a `defaultYears` fallback + a per-document-type-`code` override
 * list (seeded from getDocumentRetention, showing each type's reference
 * retention_years as the hint). Saving writes the full policy via
 * updateRetentionPolicy and invalidates the queries.
 *
 * HONESTY — none of this is decorative. The saved retention GENUINELY drives the
 * overdue register below: lowering a type's retention surfaces MORE overdue
 * documents, raising it removes them. Erasure/deletion is explicitly a MANUAL
 * process — this surface NEVER deletes or anonymises a document (there is no
 * delete button), it is an honest register. An unconfigured tenant resolves to
 * the reference retention_years, so it behaves exactly as before.
 */

const YEARS_MIN = 0;
const YEARS_MAX = 100;

/** Parse a whole-number years string in [min,max]; "" → null (no value). */
function yearsOrNull(raw: string, min = YEARS_MIN, max = YEARS_MAX): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Live client-side effective-retention preview (mirrors effectiveRetentionYears). */
function previewEffective(
  overrideRaw: string,
  referenceYears: number | null,
  defaultYearsRaw: string,
): number | null {
  const override = yearsOrNull(overrideRaw);
  if (overrideRaw.trim() !== "" && override !== null) return override;
  if (overrideRaw.trim() !== "" && override === null) return null; // invalid override → show nothing
  if (referenceYears !== null) return referenceYears;
  return yearsOrNull(defaultYearsRaw);
}

export function RetentionPolicyClient({
  initialPolicy,
  initialRetention,
  initialOverdue,
}: {
  initialPolicy: GetRetentionPolicyOutput;
  initialRetention: GetDocumentRetentionOutput;
  initialOverdue: ListDocumentsPastRetentionOutput;
}) {
  const utils = trpc.useUtils();
  const policyQuery = trpc.getRetentionPolicy.useQuery({}, { initialData: initialPolicy });
  const retentionQuery = trpc.getDocumentRetention.useQuery({}, { initialData: initialRetention });
  const overdueQuery = trpc.listDocumentsPastRetention.useQuery(
    {},
    { initialData: initialOverdue },
  );

  const policy = policyQuery.data ?? initialPolicy;
  const types = (retentionQuery.data ?? initialRetention).items;
  const overdue = (overdueQuery.data ?? initialOverdue).items;

  // Draft: a per-code override string map (blank = no override) + the tenant
  // defaultYears string. Seeded from the resolved policy.
  const [overrides, setOverrides] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const t of types) {
      const v = policy.overridesByCode[t.code];
      seed[t.code] = v === undefined ? "" : String(v);
    }
    return seed;
  });
  const [defaultYears, setDefaultYears] = useState<string>(
    policy.defaultYears === null ? "" : String(policy.defaultYears),
  );
  const [notice, setNotice] = useState<string | null>(null);

  const defaultYearsErr = defaultYears.trim() !== "" && yearsOrNull(defaultYears) === null;
  const overrideErrors = useMemo(() => {
    const e: Record<string, boolean> = {};
    for (const t of types) {
      const raw = overrides[t.code] ?? "";
      e[t.code] = raw.trim() !== "" && yearsOrNull(raw) === null;
    }
    return e;
  }, [overrides, types]);
  const hasError = defaultYearsErr || Object.values(overrideErrors).some(Boolean);

  const update = trpc.updateRetentionPolicy.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.getRetentionPolicy.invalidate(),
        utils.getDocumentRetention.invalidate(),
        utils.listDocumentsPastRetention.invalidate(),
      ]);
      setNotice(
        "Retention policy saved. The overdue register below now reflects these retention periods.",
      );
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function save() {
    if (hasError) return;
    const overridesByCode: Record<string, number> = {};
    for (const t of types) {
      const n = yearsOrNull(overrides[t.code] ?? "");
      if (n !== null) overridesByCode[t.code] = n;
    }
    const payload: UpdateRetentionPolicyInput = {
      overridesByCode,
      defaultYears: yearsOrNull(defaultYears),
    };
    setNotice(null);
    update.mutate(payload);
  }

  function clearOverrides() {
    setNotice(null);
    const cleared: Record<string, string> = {};
    for (const t of types) cleared[t.code] = "";
    setOverrides(cleared);
    setDefaultYears("");
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <PageHeader
        title="Document retention policy"
        subtitle="Set how long each document type is retained. These retention periods are real config — they drive the overdue register below, not just display."
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

      {/* Honesty banner — erasure is a manual process, this is a register only. */}
      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        A retention override wins over the document type&apos;s reference retention; where a type
        has neither, the tenant default applies (blank = never overdue). Lowering a retention
        surfaces more documents in the overdue register; raising it removes them.{" "}
        <span className="font-medium">
          Erasure is a manual process — automated deletion is not enabled.
        </span>{" "}
        Nothing on this page deletes or anonymises a document.
      </div>

      {/* Policy editor. */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Retention periods</h2>

        <div className="mb-6 flex items-start justify-between gap-6 border-b border-neutral-100 pb-5">
          <div className="pt-1">
            <div className="font-medium text-neutral-900">Tenant default retention</div>
            <div className="text-xs text-neutral-500">
              Fallback for a document type with no override and no reference retention. Blank = no
              default (such documents are never overdue).
            </div>
          </div>
          <div className="w-56">
            <Input
              type="number"
              size="sm"
              min={YEARS_MIN}
              max={YEARS_MAX}
              step={1}
              suffix="years"
              placeholder="none"
              value={defaultYears}
              aria-label="Tenant default retention years"
              onChange={(ev) => setDefaultYears(ev.currentTarget.value)}
              error={defaultYearsErr ? "Whole number 0–100" : undefined}
              disabled={update.isPending}
            />
          </div>
        </div>

        <div className="grid gap-5">
          {types.map((t) => {
            const preview = previewEffective(
              overrides[t.code] ?? "",
              t.retentionYears,
              defaultYears,
            );
            return (
              <div
                key={t.code}
                className="flex items-start justify-between gap-6 border-b border-neutral-100 pb-5 last:border-0 last:pb-0"
              >
                <div className="pt-1">
                  <div className="font-medium text-neutral-900">{t.name}</div>
                  <code className="text-xs text-neutral-500">{t.code}</code>
                  <div className="mt-1 text-xs text-neutral-500">
                    Reference: {t.retentionYears === null ? "none" : `${t.retentionYears} years`} ·
                    Effective:{" "}
                    <span className="font-medium text-neutral-700">
                      {preview === null ? "never overdue" : `${preview} years`}
                    </span>
                  </div>
                </div>
                <div className="w-56">
                  <Input
                    type="number"
                    size="sm"
                    min={YEARS_MIN}
                    max={YEARS_MAX}
                    step={1}
                    suffix="years"
                    placeholder={
                      t.retentionYears === null ? "no override" : `${t.retentionYears} (reference)`
                    }
                    value={overrides[t.code] ?? ""}
                    aria-label={`${t.name} retention override`}
                    onChange={(ev) =>
                      setOverrides((o) => ({ ...o, [t.code]: ev.currentTarget.value }))
                    }
                    error={overrideErrors[t.code] ? "Whole number 0–100" : undefined}
                    disabled={update.isPending}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button
            variant="tertiary"
            onClick={clearOverrides}
            disabled={update.isPending}
            type="button"
          >
            Clear all
          </Button>
          <Button onClick={save} disabled={update.isPending || hasError} type="button">
            {update.isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </Card>

      {/* Overdue register — honest read, NO delete action. */}
      <Card className="mt-6 p-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Documents past retention</h2>
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700">
            {overdue.length} {overdue.length === 1 ? "document" : "documents"}
          </span>
        </div>
        <p className="mb-4 text-sm text-neutral-600">
          These documents have passed their retention period under your policy. Erasure is a manual
          process; automated deletion is not enabled — this is a register, not an action queue.
        </p>

        {overdue.length === 0 ? (
          <div className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
            No documents are past their retention period under the current policy.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Document type</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 font-medium">Uploaded</th>
                  <th className="py-2 pr-4 font-medium">Age</th>
                  <th className="py-2 pr-4 font-medium">Retention</th>
                  <th className="py-2 font-medium">Owner ref</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((d) => (
                  <tr key={`${d.source}:${d.id}`} className="border-b border-neutral-100">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-neutral-900">{d.documentTypeName}</div>
                      <code className="text-xs text-neutral-500">{d.documentTypeCode}</code>
                    </td>
                    <td className="py-2 pr-4 capitalize text-neutral-700">{d.source}</td>
                    <td className="py-2 pr-4 text-neutral-700">
                      {new Date(d.uploadedAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 pr-4 text-neutral-700">{d.ageYears.toFixed(1)} yrs</td>
                    <td className="py-2 pr-4 text-neutral-700">{d.effectiveRetentionYears} yrs</td>
                    <td className="py-2">
                      <code className="text-xs text-neutral-500">{d.ownerRef}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
