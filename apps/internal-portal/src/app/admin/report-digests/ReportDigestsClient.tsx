"use client";

import { useEffect, useMemo, useState } from "react";
import {
  REPORT_DIGEST_CADENCES,
  nextDigestPreview,
  type GetReportDigestsOutput,
  type ReportDigestCadence,
  type ReportDigestPreview,
} from "@hireops/api-types";
import { Input } from "@hireops/ui";
import { Button, Badge, Card } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * R1.5b — the scheduled report-digest admin surface.
 *
 * Configures tenants.settings.reportDigests (enabled / cadence / recipients /
 * send hour). The saved block drives the report_digest_scan worker, which emails
 * the executive board-pack headline for the period that just CLOSED — so this
 * form is a real send configuration, never a preference panel.
 *
 * THE POINT OF THE PAGE is the derived "next digest" panel. It is computed live
 * from the CURRENT form state via `nextDigestPreview` — the same
 * `digestPeriod` / `shouldSendDigest` pair the worker gates on — so flipping the
 * cadence visibly flips the previewed period and moving the send hour visibly
 * moves the instant, before anything is saved. Nothing about the next send is
 * stored anywhere; if it were, it would be a second thing that has to agree with
 * the worker. Same discipline as /admin/costs, where changing the budget flips
 * the server-computed status band.
 *
 * EVERY TIME IS UTC, said out loud. The whole pipeline — period boundaries,
 * report SQL date bounds, the send gate — cuts on UTC. A tenant reading in IST
 * would otherwise take "07:00" for a local morning and be five and a half hours
 * out; labelling the field and the preview "UTC" is cheaper than a per-tenant
 * timezone that the report bounds would not honour anyway.
 */

/** Mirrors `reportDigestsSchema`'s `.max(10)` — the server rejects past this. */
const MAX_RECIPIENTS = 10;

const CADENCE_META: Record<ReportDigestCadence, { label: string; hint: string }> = {
  weekly: { label: "Weekly", hint: "Covers the ISO week (Mon–Sun) that just ended." },
  monthly: { label: "Monthly", hint: "Covers the calendar month that just ended." },
};

export function ReportDigestsClient({ initial }: { initial: GetReportDigestsOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.getReportDigests.useQuery(
    {},
    { initialData: initial, refetchOnWindowFocus: false, staleTime: 5_000 },
  );
  const saved = query.data ?? initial;

  const [enabled, setEnabled] = useState(saved.enabled);
  const [cadence, setCadence] = useState<ReportDigestCadence>(saved.cadence);
  const [recipients, setRecipients] = useState<string[]>(saved.recipients);
  const [sendHourUtc, setSendHourUtc] = useState(saved.sendHourUtc);
  const [draftRecipient, setDraftRecipient] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The preview is clock-dependent, so it is computed only after mount: rendering
  // `new Date()` during SSR and again on hydration is a mismatch waiting for a
  // period boundary to happen between the two. Re-ticking each minute keeps the
  // panel honest as the send hour passes rather than freezing at page load.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const preview = useMemo(
    () => (now ? nextDigestPreview(cadence, sendHourUtc, now) : null),
    [cadence, sendHourUtc, now],
  );

  const dirty =
    enabled !== saved.enabled ||
    cadence !== saved.cadence ||
    sendHourUtc !== saved.sendHourUtc ||
    recipients.join(",") !== saved.recipients.join(",");

  const update = trpc.updateReportDigests.useMutation({
    onSuccess: async (res) => {
      // Re-seed from what was PERSISTED, not from local state: the server
      // lower-cases, dedupes and sorts recipients, and the form should show the
      // list the worker will actually use.
      setEnabled(res.reportDigests.enabled);
      setCadence(res.reportDigests.cadence);
      setRecipients(res.reportDigests.recipients);
      setSendHourUtc(res.reportDigests.sendHourUtc);
      setError(null);
      setNotice("Digest settings saved.");
      await utils.getReportDigests.invalidate();
    },
    onError: (err) => {
      setNotice(null);
      handleTRPCError(err, { onMessage: setError });
    },
  });

  function addRecipient() {
    const value = draftRecipient.trim().toLowerCase();
    if (value === "") return;
    if (!isEmail(value)) {
      setError(`Not a valid email address: ${value}`);
      return;
    }
    if (recipients.includes(value)) {
      setError(`${value} is already on the list.`);
      return;
    }
    if (recipients.length >= MAX_RECIPIENTS) {
      setError(`At most ${MAX_RECIPIENTS} recipients.`);
      return;
    }
    setError(null);
    setNotice(null);
    // Sorted on insert so the form matches how the block is stored + rendered
    // back by resolveReportDigests (lower-cased, deduped, sorted).
    setRecipients((cur) => [...cur, value].sort());
    setDraftRecipient("");
  }

  function removeRecipient(email: string) {
    setError(null);
    setNotice(null);
    setRecipients((cur) => cur.filter((r) => r !== email));
  }

  function save() {
    setNotice(null);
    setError(null);
    update.mutate({ version: 1, enabled, cadence, recipients, sendHourUtc });
  }

  function discard() {
    setEnabled(saved.enabled);
    setCadence(saved.cadence);
    setRecipients(saved.recipients);
    setSendHourUtc(saved.sendHourUtc);
    setDraftRecipient("");
    setNotice(null);
    setError(null);
  }

  return (
    <PageContainer variant="measure">
      <p className="mb-6 text-sm text-neutral-600">
        Email the executive summary&apos;s headline numbers on a schedule. Each digest covers the
        period that has just <strong>closed</strong> — never a part-finished one — and carries the
        same figures the{" "}
        <a href="/reports" className="font-medium text-brand-700 hover:underline">
          reports catalog
        </a>{" "}
        shows for that window. AI spend and governance figures are excluded: digest recipients are
        mailboxes, not signed-in admins.
      </p>

      {notice ? (
        <div className="mb-4 rounded-lg border border-status-positive-200 bg-status-positive-50 px-4 py-3 text-sm text-status-positive-700">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-lg border border-status-error-200 bg-status-error-50 px-4 py-3 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label="Send scheduled report digests"
              className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
            />
            <span>
              <span className="block text-sm font-semibold text-neutral-900">
                Send scheduled report digests
              </span>
              <span className="block text-xs text-neutral-500">
                Master switch. When off nothing is sent, whatever the settings below say.
              </span>
            </span>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-1 text-sm font-semibold text-neutral-900">Cadence &amp; send time</h3>
          <p className="mb-3 text-xs text-neutral-500">
            The digest goes out after the period closes, from the send hour onwards. The scan runs
            every 30 minutes, so a late worker still sends — once — rather than skipping a period.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-neutral-700">Cadence</span>
              <select
                className="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ReportDigestCadence)}
              >
                {REPORT_DIGEST_CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_META[c].label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-neutral-500">{CADENCE_META[cadence].hint}</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-neutral-700">Send hour (UTC)</span>
              <select
                className="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={sendHourUtc}
                onChange={(e) => setSendHourUtc(Number(e.target.value))}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {formatHourUtc(h)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-neutral-500">
                UTC, not local time — the reporting windows are cut on UTC days, so the send hour is
                too. 07:00 UTC is 12:30 IST.
              </span>
            </label>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-1 text-sm font-semibold text-neutral-900">Recipients</h3>
          <p className="mb-3 text-xs text-neutral-500">
            Plain mailboxes — a sponsor, a leadership list. They need not be HireOps users, which is
            exactly why the digest omits AI spend and governance detail. Up to {MAX_RECIPIENTS}.
          </p>
          <div className="flex items-end gap-2">
            <Input
              className="flex-1"
              type="email"
              label="Add a recipient"
              value={draftRecipient}
              placeholder="sponsor@example.com"
              onChange={(e) => setDraftRecipient(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRecipient();
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={addRecipient}
              disabled={recipients.length >= MAX_RECIPIENTS}
            >
              Add
            </Button>
          </div>

          {recipients.length === 0 ? (
            <p className="mt-3 text-xs text-neutral-500">
              No recipients yet. With none configured nothing is sent, even with digests enabled.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
              {recipients.map((r) => (
                <li key={r} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="truncate text-sm text-neutral-800">{r}</span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-status-error-600 hover:underline"
                    onClick={() => removeRecipient(r)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <NextDigestPanel
          preview={preview}
          cadence={cadence}
          enabled={enabled}
          recipientCount={recipients.length}
          dirty={dirty}
        />
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button type="button" onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save digest settings"}
        </Button>
        {dirty ? (
          <button
            type="button"
            className="text-sm text-neutral-600 hover:underline"
            onClick={discard}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </PageContainer>
  );
}

/**
 * The derived preview. Everything here comes from `nextDigestPreview` over the
 * live form state — there is no stored "next send" to read, and deliberately so.
 *
 * It reports the period that is definitely still to come. Once the send gate for
 * the just-closed period has opened, this cannot tell "already emailed" from
 * "the next 30-minute tick will email it" without reading the outbox, so it
 * shows the following period and says the current window is still open rather
 * than claiming a send happened. The dedup key, not this panel, is what makes
 * the send exactly-once.
 */
function NextDigestPanel({
  preview,
  cadence,
  enabled,
  recipientCount,
  dirty,
}: {
  preview: ReportDigestPreview | null;
  cadence: ReportDigestCadence;
  enabled: boolean;
  recipientCount: number;
  dirty: boolean;
}) {
  const willSend = enabled && recipientCount > 0;

  return (
    <Card className="border-brand-200 bg-brand-50/40 p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-neutral-900">Next digest</h3>
        <Badge tone={willSend ? "success" : "neutral"}>
          {willSend ? "Scheduled" : enabled ? "No recipients" : "Digests off"}
        </Badge>
        {dirty ? <Badge tone="warning">Unsaved — preview reflects your edits</Badge> : null}
      </div>

      {preview === null ? (
        <p className="text-sm text-neutral-500">Working out the next window…</p>
      ) : (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Covers</dt>
            <dd className="text-sm font-medium text-neutral-900">{preview.label}</dd>
            <dd className="font-mono text-xs text-neutral-500">{preview.periodKey}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Window (UTC)</dt>
            <dd className="text-sm text-neutral-800">
              {formatInstantUtc(preview.from)} → {formatInstantUtc(preview.to)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Sends from</dt>
            <dd className="text-sm font-medium text-neutral-900">
              {formatInstantUtc(preview.sendsAt)}
            </dd>
            <dd className="text-xs text-neutral-500">
              {preview.periodClosed
                ? "This period has closed — its numbers are final."
                : `This ${cadence === "monthly" ? "month" : "week"} is still open; the digest for the previous one is already due or sent.`}
            </dd>
          </div>
        </dl>
      )}

      <p className="mt-4 text-xs text-neutral-600">
        {willSend
          ? `${recipientCount} recipient${recipientCount === 1 ? "" : "s"} will each receive one email per period — the scan enqueues at most one digest per recipient per period, so a retry or a late worker cannot double-send.`
          : "Nothing will be sent with the settings above; this is what would go out once digests are enabled and at least one recipient is added."}
      </p>
    </Card>
  );
}

/** 0–23, the hours `reportDigestsSchema` accepts for `sendHourUtc`. */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** 7 → "07:00 UTC". The suffix is deliberate everywhere an hour is shown. */
function formatHourUtc(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00 UTC`;
}

/** ISO instant → "17 Aug 2026, 07:00 UTC". Rendered in UTC to match the window
 * the numbers are computed over; a friendlier local clock would disagree with
 * the period boundaries the report actually used. */
function formatInstantUtc(iso: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return `${formatted} UTC`;
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
