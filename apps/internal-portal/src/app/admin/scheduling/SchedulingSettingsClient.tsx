"use client";

import { useState } from "react";
import type { GetSchedulingSettingsOutput } from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin editor for tenants.settings.scheduling (PC-8). Every value here really
 * drives behaviour: the duration chips in the schedule flow, the slot engine
 * (working window, zone, buffer, notice, horizon, grid), how many times a
 * candidate is offered, how long their link works, and how often they may
 * reschedule. The platform default zone is UTC; leaving the zone blank
 * inherits the tenant's general time zone if one is set.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Draft = Omit<
  GetSchedulingSettingsOutput,
  "timezone" | "timezoneSource" | "timezoneOverride"
> & {
  timezone: string;
  durationPresetsText: string;
};

function toDraft(s: GetSchedulingSettingsOutput): Draft {
  return {
    ...s,
    timezone: s.timezoneOverride ?? "",
    durationPresetsText: s.durationPresets.join(", "),
  };
}

export function SchedulingSettingsClient({ initial }: { initial: GetSchedulingSettingsOutput }) {
  const utils = trpc.useUtils();
  const q = trpc.getSchedulingSettings.useQuery({}, { initialData: initial });
  const resolved = q.data ?? initial;
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateSchedulingSettings.useMutation({
    onSuccess: async (res) => {
      await utils.getSchedulingSettings.invalidate();
      setD(toDraft(res.scheduling));
      setNotice("Scheduling settings saved.");
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const presets = d.durationPresetsText
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  function num(key: keyof Draft, label: string, hint: string, suffix?: string) {
    return (
      <Input
        type="number"
        size="sm"
        label={label}
        hint={hint}
        suffix={suffix}
        value={String(d[key] as number)}
        onChange={(e) => setD((x) => ({ ...x, [key]: Number(e.currentTarget.value) }))}
        disabled={update.isPending}
      />
    );
  }

  function save() {
    setNotice(null);
    update.mutate({
      timezone: d.timezone.trim() || null,
      durationPresets: presets,
      defaultDurationMinutes: d.defaultDurationMinutes,
      workingHoursStart: d.workingHoursStart,
      workingHoursEnd: d.workingHoursEnd,
      workingDays: d.workingDays,
      bufferMinutes: d.bufferMinutes,
      minNoticeHours: d.minNoticeHours,
      slotHorizonDays: d.slotHorizonDays,
      slotIncrementMinutes: d.slotIncrementMinutes,
      maxSlotsOffered: d.maxSlotsOffered,
      offerLinkValidityHours: d.offerLinkValidityHours,
      maxCandidateReschedules: d.maxCandidateReschedules,
      assumeWorkingHoursWhenNoAvailability: d.assumeWorkingHoursWhenNoAvailability,
    });
  }

  return (
    <PageContainer variant="measure" className="py-8">
      <PageHeader
        title="Interview scheduling"
        subtitle="How common interview times are found and offered to candidates. Availability is held in HireOps; no external calendar is read."
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

      <Card className="mt-6 grid gap-5 p-6 sm:grid-cols-2">
        <Input
          size="sm"
          label="Time zone (IANA)"
          hint={`In use: ${resolved.timezone} (${
            resolved.timezoneSource === "scheduling"
              ? "set here"
              : resolved.timezoneSource === "tenant"
                ? "tenant default"
                : "platform default"
          }). Leave blank to inherit.`}
          placeholder="e.g. Europe/Berlin"
          value={d.timezone}
          onChange={(e) => setD((x) => ({ ...x, timezone: e.currentTarget.value }))}
        />
        <Input
          size="sm"
          label="Duration presets (minutes)"
          hint="Comma-separated chips in the schedule form."
          value={d.durationPresetsText}
          onChange={(e) => setD((x) => ({ ...x, durationPresetsText: e.currentTarget.value }))}
        />
        {num("defaultDurationMinutes", "Default duration", "Must be one of the presets.", "min")}
        {num("bufferMinutes", "Buffer between interviews", "Kept free either side.", "min")}
        <label className="block text-sm font-medium text-neutral-700">
          Working hours start
          <input
            type="time"
            value={d.workingHoursStart}
            onChange={(e) => setD((x) => ({ ...x, workingHoursStart: e.currentTarget.value }))}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm font-normal"
          />
        </label>
        <label className="block text-sm font-medium text-neutral-700">
          Working hours end
          <input
            type="time"
            value={d.workingHoursEnd === "24:00" ? "23:59" : d.workingHoursEnd}
            onChange={(e) => setD((x) => ({ ...x, workingHoursEnd: e.currentTarget.value }))}
            className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm font-normal"
          />
        </label>
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-medium text-neutral-700">Working days</p>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((label, i) => {
              const on = d.workingDays.includes(i);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setD((x) => ({
                      ...x,
                      workingDays: on
                        ? x.workingDays.filter((v) => v !== i)
                        : [...x.workingDays, i].sort(),
                    }))
                  }
                  className={
                    on
                      ? "rounded-full border border-brand-600 bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                      : "rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700"
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        {num("minNoticeHours", "Minimum notice", "No slot sooner than this.", "hours")}
        {num("slotHorizonDays", "Look ahead", "No slot later than this.", "days")}
        {num("slotIncrementMinutes", "Slot grid", "Start times every…", "min")}
        {num("maxSlotsOffered", "Times offered to a candidate", "At most this many.", "slots")}
        {num(
          "offerLinkValidityHours",
          "Pick-a-time link lifetime",
          "After this the link expires.",
          "hours",
        )}
        {num(
          "maxCandidateReschedules",
          "Candidate reschedules per round",
          "0 turns self-service rescheduling off.",
        )}
        <label className="flex items-start gap-2 text-sm text-neutral-700 sm:col-span-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={d.assumeWorkingHoursWhenNoAvailability}
            onChange={(e) =>
              setD((x) => ({ ...x, assumeWorkingHoursWhenNoAvailability: e.target.checked }))
            }
          />
          <span>
            Treat panellists who haven&apos;t set availability as free during working hours.
            <span className="block text-xs text-neutral-500">
              Off by default: without it, someone with no declared hours is never offered.
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button
            variant="tertiary"
            type="button"
            onClick={() => setD(toDraft(resolved))}
            disabled={update.isPending}
          >
            Discard changes
          </Button>
          <Button type="button" onClick={save} disabled={update.isPending || presets.length === 0}>
            {update.isPending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </Card>
    </PageContainer>
  );
}
