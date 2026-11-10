"use client";

import { useEffect, useState } from "react";
import { Button, Select } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";
import { formatSlot, viewerTimeZone } from "@/components/scheduling/slot-format";

/**
 * PC-8 — weekly availability + out-of-office editor.
 *
 * Windows are wall-clock times in a named zone (default: the viewer's browser
 * zone), so "Mon 09:00–17:00 Europe/Berlin" stays 09:00 Berlin across a DST
 * change. Out-of-office ranges are concrete instants entered in the viewer's
 * zone. Adding one over an upcoming interview flags it and offers the
 * candidate new times automatically — the page says so before you save.
 */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Display order: Monday first. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface DraftWindow {
  dayOfWeek: number;
  start: string;
  end: string;
  timezone: string;
}

function toIsoFromLocal(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function AvailabilityClient({ canViewOthers }: { canViewOthers: boolean }) {
  const utils = trpc.useUtils();
  const [target, setTarget] = useState<string>("");
  const members = trpc.listTenantMemberships.useQuery(undefined, { enabled: canViewOthers });
  const q = trpc.getPanelistAvailability.useQuery(target ? { membershipId: target } : {});
  const data = q.data;
  const [zone, setZone] = useState<string>("");
  const [draft, setDraft] = useState<DraftWindow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const tz = data.windows[0]?.timezone ?? viewerTimeZone();
    setZone(tz);
    setDraft(data.windows.map((w) => ({ ...w })));
  }, [data]);

  const save = trpc.setPanelistAvailabilityWindows.useMutation({
    onSuccess: async () => {
      setNotice("Availability saved.");
      await utils.getPanelistAvailability.invalidate();
    },
  });

  const [oooFrom, setOooFrom] = useState("");
  const [oooTo, setOooTo] = useState("");
  const [oooReason, setOooReason] = useState("");
  const addException = trpc.addAvailabilityException.useMutation({
    onSuccess: async (res) => {
      setOooFrom("");
      setOooTo("");
      setOooReason("");
      setNotice(
        res.affectedInterviewIds.length === 0
          ? "Out-of-office saved."
          : `Out-of-office saved. ${res.affectedInterviewIds.length} upcoming interview(s) overlap it; ${res.reofferedInterviewIds.length} candidate(s) have been sent new times.`,
      );
      await utils.getPanelistAvailability.invalidate();
    },
  });
  const removeException = trpc.removeAvailabilityException.useMutation({
    onSuccess: () => utils.getPanelistAvailability.invalidate(),
  });

  const canEdit = data?.canEdit ?? false;

  function addWindow(dayOfWeek: number) {
    setDraft((d) => [...d, { dayOfWeek, start: "09:00", end: "17:00", timezone: zone }]);
  }
  function updateWindow(i: number, patch: Partial<DraftWindow>) {
    setDraft((d) => d.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  }
  function removeWindow(i: number) {
    setDraft((d) => d.filter((_, idx) => idx !== i));
  }
  function copyMondayToWeekdays() {
    const monday = draft.filter((w) => w.dayOfWeek === 1);
    if (monday.length === 0) return;
    const rest = draft.filter((w) => w.dayOfWeek < 1 || w.dayOfWeek > 5);
    const copies = [1, 2, 3, 4, 5].flatMap((d) => monday.map((w) => ({ ...w, dayOfWeek: d })));
    setDraft([...copies, ...rest]);
  }

  const invalid = draft.some((w) => !w.start || !w.end || w.end <= w.start);

  return (
    <PageContainer variant="measure" className="py-8">
      <PageHeader
        title={data && target ? `Availability: ${data.displayName ?? "member"}` : "My availability"}
        subtitle="When you can sit on an interview panel. Recruiters find common times from this, and candidates pick from those times. Nothing is read from an external calendar."
      />

      {canViewOthers ? (
        <div className="mt-4 max-w-sm">
          <Select
            label="View a member"
            size="sm"
            placeholder="Me"
            options={[
              { value: "", label: "Me" },
              ...(members.data?.items ?? []).map((m) => ({
                value: m.membershipId,
                label: m.displayName ?? m.email ?? m.membershipId.slice(0, 8),
              })),
            ]}
            value={target}
            onValueChange={(v) => {
              setNotice(null);
              setTarget(v);
            }}
          />
        </div>
      ) : null}

      {notice ? (
        <div className="mt-4 rounded-lg border border-status-success-200 bg-status-success-50 px-4 py-2 text-sm text-status-success-700">
          {notice}
        </div>
      ) : null}

      <Card className="mt-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-900">Weekly hours</h2>
          {canEdit ? (
            <label className="flex items-center gap-2 text-xs text-neutral-600">
              Time zone
              <input
                value={zone}
                onChange={(e) => {
                  const tz = e.target.value;
                  setZone(tz);
                  setDraft((d) => d.map((w) => ({ ...w, timezone: tz })));
                }}
                className="w-48 rounded-md border border-neutral-300 px-2 py-1 text-xs"
                aria-label="Time zone (IANA name)"
              />
            </label>
          ) : (
            <span className="text-xs text-neutral-500">Time zone: {zone || "—"}</span>
          )}
        </div>
        {q.isLoading ? <p className="mt-3 text-sm text-neutral-500">Loading…</p> : null}
        <div className="mt-3 divide-y divide-neutral-100">
          {DAY_ORDER.map((dow) => {
            const rows = draft.map((w, i) => ({ w, i })).filter(({ w }) => w.dayOfWeek === dow);
            return (
              <div key={dow} className="flex flex-wrap items-start gap-3 py-2">
                <span className="w-24 pt-1 text-sm font-medium text-neutral-700">{DAYS[dow]}</span>
                <div className="flex flex-1 flex-col gap-1.5">
                  {rows.length === 0 ? (
                    <span className="pt-1 text-sm text-neutral-400">Unavailable</span>
                  ) : (
                    rows.map(({ w, i }) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="time"
                          value={w.start}
                          disabled={!canEdit}
                          onChange={(e) => updateWindow(i, { start: e.target.value })}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
                          aria-label={`${DAYS[dow]} start`}
                        />
                        <span className="text-neutral-400">–</span>
                        <input
                          type="time"
                          value={w.end === "24:00" ? "23:59" : w.end}
                          disabled={!canEdit}
                          onChange={(e) => updateWindow(i, { end: e.target.value })}
                          className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
                          aria-label={`${DAYS[dow]} end`}
                        />
                        {canEdit ? (
                          <button
                            type="button"
                            className="text-xs text-neutral-500 hover:text-status-error-700"
                            onClick={() => removeWindow(i)}
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    className="pt-1 text-xs font-medium text-brand-700 hover:underline"
                    onClick={() => addWindow(dow)}
                  >
                    + Add hours
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {canEdit ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <Button variant="tertiary" size="sm" type="button" onClick={copyMondayToWeekdays}>
              Copy Monday to Mon–Fri
            </Button>
            <div className="flex items-center gap-2">
              {invalid ? (
                <span className="text-xs text-status-error-700">
                  Each window must end after it starts.
                </span>
              ) : null}
              {save.error ? (
                <span className="text-xs text-status-error-700">{save.error.message}</span>
              ) : null}
              <Button
                size="sm"
                type="button"
                disabled={invalid || save.isPending}
                loading={save.isPending}
                onClick={() => {
                  setNotice(null);
                  save.mutate({
                    membershipId: target || undefined,
                    windows: draft.map((w) => ({ ...w, timezone: zone })),
                  });
                }}
              >
                Save weekly hours
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Out of office / blocked time</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Times shown in your time zone ({viewerTimeZone()}). Adding a range over an upcoming
          interview marks it for rescheduling and sends the candidate new times automatically.
        </p>
        <ul className="mt-3 space-y-2">
          {(data?.exceptions ?? []).length === 0 ? (
            <li className="text-sm text-neutral-400">Nothing upcoming.</li>
          ) : (
            (data?.exceptions ?? []).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <Badge tone={e.kind === "cannot_attend" ? "warning" : "neutral"}>
                    {e.kind === "cannot_attend"
                      ? "Can't attend"
                      : e.kind === "out_of_office"
                        ? "Out of office"
                        : "Blocked"}
                  </Badge>{" "}
                  {formatSlot(e.startsAt)} → {formatSlot(e.endsAt)}
                  {e.reason ? <span className="text-neutral-500"> · {e.reason}</span> : null}
                </span>
                {canEdit && e.kind !== "cannot_attend" ? (
                  <Button
                    variant="tertiary"
                    size="sm"
                    type="button"
                    disabled={removeException.isPending}
                    onClick={() => removeException.mutate({ exceptionId: e.id })}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))
          )}
        </ul>
        {canEdit ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <label className="block text-xs text-neutral-600">
              From
              <input
                type="datetime-local"
                value={oooFrom}
                onChange={(e) => setOooFrom(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-xs text-neutral-600">
              To
              <input
                type="datetime-local"
                value={oooTo}
                onChange={(e) => setOooTo(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-xs text-neutral-600">
              Reason (optional)
              <input
                type="text"
                maxLength={500}
                value={oooReason}
                onChange={(e) => setOooReason(e.target.value)}
                className="mt-1 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
            </label>
            <Button
              size="sm"
              type="button"
              disabled={
                addException.isPending ||
                !toIsoFromLocal(oooFrom) ||
                !toIsoFromLocal(oooTo) ||
                oooTo <= oooFrom
              }
              loading={addException.isPending}
              onClick={() => {
                const startsAt = toIsoFromLocal(oooFrom);
                const endsAt = toIsoFromLocal(oooTo);
                if (!startsAt || !endsAt) return;
                setNotice(null);
                addException.mutate({
                  membershipId: target || undefined,
                  startsAt,
                  endsAt,
                  kind: "out_of_office",
                  reason: oooReason.trim() || undefined,
                });
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
        {addException.error ? (
          <p className="mt-2 text-xs text-status-error-700">{addException.error.message}</p>
        ) : null}
      </Card>
    </PageContainer>
  );
}
