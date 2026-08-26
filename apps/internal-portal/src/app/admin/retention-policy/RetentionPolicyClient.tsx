"use client";

import { PageContainer } from "@/components/nav/PageContainer";
import { useMemo, useState } from "react";
import {
  INTERVIEW_AUDIO_HARD_CEILING_DAYS,
  INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT,
  type GetRetentionPolicyOutput,
  type GetDocumentRetentionOutput,
  type ListDocumentsPastRetentionOutput,
  type UpdateRetentionPolicyInput,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
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
 *
 * A2 — THE INTERVIEW-AUDIO SECTION IS THE EXCEPTION TO ALL OF THAT, and the UI
 * has to say so rather than let it inherit the register's reassurance. That one
 * field drives a daily worker sweep that really deletes the audio files. The
 * copy below therefore states, in the section itself: the 90-day platform
 * ceiling that applies whatever is typed here; that transcripts and notes are
 * kept regardless; and — the part that is easy to leave out and expensive to
 * discover — that a LOWERED value applies to recordings ALREADY held, so the
 * next sweep can delete audio this tenant had been keeping. Both fields save
 * through the one updateRetentionPolicy mutation, because they are one settings
 * block; the write always carries both, so saving document changes cannot
 * silently reset the audio window (or the reverse).
 */

const YEARS_MIN = 0;
const YEARS_MAX = 100;

/**
 * A2 — interview-audio retention bounds, in DAYS. Mirrors the schema's
 * `interviewAudioDays` (min 1, max INTERVIEW_AUDIO_HARD_CEILING_DAYS): the
 * ceiling is imported rather than typed out so the field can never offer a
 * number the purge sweep would override, and the floor is 1 rather than 0
 * because 0 would mean "delete everything on tonight's sweep" — too destructive
 * to be one keystroke away from.
 */
const AUDIO_DAYS_MIN = 1;
const AUDIO_DAYS_MAX = INTERVIEW_AUDIO_HARD_CEILING_DAYS;

/** Parse a whole-number years string in [min,max]; "" → null (no value). */
function yearsOrNull(raw: string, min = YEARS_MIN, max = YEARS_MAX): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * A2 — the same bounded-whole-number parse for the audio field, named for what
 * it parses. Blank is INVALID here, unlike the years fields where blank means
 * "no retention configured": there is no such thing as an unset audio window,
 * so an empty box has to be an error rather than a silent fall-back to 30.
 */
function audioDaysOrNull(raw: string): number | null {
  return yearsOrNull(raw, AUDIO_DAYS_MIN, AUDIO_DAYS_MAX);
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
  // A2 — days, not years, and NOT blankable: every tenant has an audio
  // retention window whether or not it chose one, so there is no "unset" to
  // express. Seeded from the resolved policy (the default 30 for a tenant that
  // has never touched it).
  const [audioDays, setAudioDays] = useState<string>(String(policy.interviewAudioDays));
  const [notice, setNotice] = useState<string | null>(null);

  const defaultYearsErr = defaultYears.trim() !== "" && yearsOrNull(defaultYears) === null;
  const audioDaysValue = audioDaysOrNull(audioDays);
  const audioDaysErr = audioDaysValue === null;
  const overrideErrors = useMemo(() => {
    const e: Record<string, boolean> = {};
    for (const t of types) {
      const raw = overrides[t.code] ?? "";
      e[t.code] = raw.trim() !== "" && yearsOrNull(raw) === null;
    }
    return e;
  }, [overrides, types]);
  const hasError = defaultYearsErr || audioDaysErr || Object.values(overrideErrors).some(Boolean);

  const update = trpc.updateRetentionPolicy.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.getRetentionPolicy.invalidate(),
        utils.getDocumentRetention.invalidate(),
        utils.listDocumentsPastRetention.invalidate(),
      ]);
      setNotice(
        "Retention policy saved. The overdue register below now reflects the document " +
          "retention periods, and the interview-audio window applies from the next daily sweep.",
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
      // Non-null by the hasError guard above — audioDaysErr covers blank, a
      // non-integer, and anything outside 1..90.
      interviewAudioDays: audioDaysValue ?? policy.interviewAudioDays,
    };
    setNotice(null);
    update.mutate(payload);
  }

  // "Clear all" is the DOCUMENT half's control and stays that way. It does not
  // reset the audio window: clearing document overrides is harmless (fewer rows
  // on a register), whereas silently returning audio retention to 30 days could
  // schedule a tenant's recordings for deletion under a button that promised
  // nothing of the sort.
  function clearOverrides() {
    setNotice(null);
    const cleared: Record<string, string> = {};
    for (const t of types) cleared[t.code] = "";
    setOverrides(cleared);
    setDefaultYears("");
  }

  return (
    <PageContainer variant="measure" className="py-8">
      <PageHeader
        title="Retention policy"
        subtitle="How long uploaded documents are retained, and how long interview audio is kept before it is deleted. Both are real config, not display: documents drive the overdue register below, and the audio window drives a daily deletion sweep."
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
          Erasure is a manual process, automated deletion is not enabled.
        </span>{" "}
        Nothing on this page deletes or anonymises a document.
      </div>

      {/* Policy editor. */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Document retention periods</h2>

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
      </Card>

      {/* Interview audio (A2) — the half of this block that DELETES things.
          Kept in its own card, in days rather than years, with the three facts
          a tenant has to have been told before it lowers this number. */}
      <Card className="mt-6 p-6">
        <h2 className="mb-1 text-sm font-semibold text-neutral-900">Interview audio</h2>
        <p className="mb-4 text-sm text-neutral-600">
          How long recorded interview audio is kept, counted from when the interview is completed or
          cancelled. Unlike the document periods above, this one is enforced: a daily sweep
          permanently deletes the audio files once they are past it.
        </p>

        <div className="flex items-start justify-between gap-6">
          <div className="pt-1">
            <div className="font-medium text-neutral-900">Keep interview audio for</div>
            <div className="text-xs text-neutral-500">
              Whole days, {AUDIO_DAYS_MIN}–{AUDIO_DAYS_MAX}. Platform default{" "}
              {INTERVIEW_AUDIO_RETENTION_DAYS_DEFAULT} days.
            </div>
          </div>
          <div className="w-56">
            <Input
              type="number"
              size="sm"
              min={AUDIO_DAYS_MIN}
              max={AUDIO_DAYS_MAX}
              step={1}
              suffix="days"
              value={audioDays}
              aria-label="Interview audio retention days"
              onChange={(ev) => setAudioDays(ev.currentTarget.value)}
              error={audioDaysErr ? `Whole number ${AUDIO_DAYS_MIN}–${AUDIO_DAYS_MAX}` : undefined}
              disabled={update.isPending}
            />
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-status-warning-200 bg-status-warning-50 px-4 py-3 text-sm text-status-warning-800">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="font-medium">
                Audio is deleted after {AUDIO_DAYS_MAX} days regardless of this setting.
              </span>{" "}
              That ceiling is a platform guarantee and cannot be raised — it also catches rounds
              that were never completed or cancelled, which this setting can never reach. You can
              only choose to delete audio sooner.
            </li>
            <li>
              <span className="font-medium">Transcripts and interview notes are not affected.</span>{" "}
              They are kept indefinitely; only the audio file is deleted.
            </li>
            <li>
              <span className="font-medium">
                This applies to recordings you already hold, not just new ones.
              </span>{" "}
              Changes take effect from the next daily sweep, so lowering this number can permanently
              delete audio that was being kept under the old one. Deletion cannot be undone.
            </li>
          </ul>
        </div>
      </Card>

      {/* One block, one write: both cards above save through the same
          updateRetentionPolicy mutation, so the action row belongs to neither
          of them individually. */}
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          variant="tertiary"
          onClick={clearOverrides}
          disabled={update.isPending}
          type="button"
        >
          Clear document overrides
        </Button>
        <Button onClick={save} disabled={update.isPending || hasError} type="button">
          {update.isPending ? "Saving…" : "Save policy"}
        </Button>
      </div>

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
          process; automated deletion is not enabled, this is a register, not an action queue.
        </p>

        {overdue.length === 0 ? (
          <div className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
            No documents are past their retention period under the current policy.
          </div>
        ) : (
          <TableShell>
            <Thead>
              <Th>Document type</Th>
              <Th>Source</Th>
              <Th>Uploaded</Th>
              <Th>Age</Th>
              <Th>Retention</Th>
              <Th>Owner ref</Th>
            </Thead>
            <Tbody>
              {overdue.map((d) => (
                <Tr key={`${d.source}:${d.id}`}>
                  <Td>
                    <div className="font-medium text-neutral-900">{d.documentTypeName}</div>
                    <code className="text-xs text-neutral-500">{d.documentTypeCode}</code>
                  </Td>
                  <Td label="Source" className="capitalize text-neutral-700">
                    {d.source}
                  </Td>
                  <Td label="Uploaded" className="text-neutral-700">
                    {new Date(d.uploadedAt).toLocaleDateString()}
                  </Td>
                  <Td label="Age" className="text-neutral-700">
                    {d.ageYears.toFixed(1)} yrs
                  </Td>
                  <Td label="Retention" className="text-neutral-700">
                    {d.effectiveRetentionYears} yrs
                  </Td>
                  <Td label="Owner ref">
                    <code className="text-xs text-neutral-500">{d.ownerRef}</code>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </TableShell>
        )}
      </Card>
    </PageContainer>
  );
}
