"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { Select } from "@hireops/ui";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import {
  LEARNING_TRACK_LAYER_LABELS,
  formatMinutes,
  layerTone,
  providerLabel,
  totalMinutes,
} from "@/components/learning/learning-format";

/** Radix Select forbids "" values — sentinel for "push loose resources only". */
const NO_TRACK = "__no_track__";

/**
 * Assign learning to ONE hire (LD-1B) — the push.
 *
 * A recruiter decides what this hire needs and pushes it: a curated track, a
 * handful of loose catalogue resources, or both. `assignLearningToCase`
 * materialises one ordinary onboarding task per resource (so the items land in
 * the checklist above, under "Learning & development") and enqueues one
 * candidate notification per newly-assigned resource.
 *
 * The push is IDEMPOTENT on (case, resource): re-pushing adds only what is new
 * and never resets progress on what the hire has already started. Archived
 * catalogue rows are skipped server-side — a retired link is never pushed.
 *
 * Allowed at any case status: a pre-boarding hire who hasn't activated their
 * portal account still gets the notification and finds the items waiting. The
 * recruiter owns the timing.
 *
 * The catalogue reads are lazy — they only fire once the panel is opened, so a
 * case detail page never pays for them (nor surfaces a role error) unprompted.
 */
export function AssignLearningPanel({ caseId }: { caseId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [trackId, setTrackId] = useState<string>(NO_TRACK);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const tracksQuery = trpc.listLearningTracks.useQuery(
    {},
    { enabled: open, retry: false, staleTime: 60_000 },
  );
  const resourcesQuery = trpc.listLearningResources.useQuery(
    {},
    { enabled: open, retry: false, staleTime: 60_000 },
  );

  const assign = trpc.assignLearningToCase.useMutation({
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: [["getOnboardingCaseDetail"]] });
      queryClient.invalidateQueries({ queryKey: [["listOnboardingCases"]] });
      setTrackId(NO_TRACK);
      setPicked(new Set());
      setError(null);
      setResult(
        res.assigned === 0
          ? `Nothing new to push — this hire already has all ${res.skipped} of those items, and their progress is untouched.`
          : `Pushed ${res.assigned} item${res.assigned === 1 ? "" : "s"} to their onboarding checklist` +
              (res.skipped > 0 ? `, skipped ${res.skipped} they already had` : "") +
              `. ${res.notified} notification${res.notified === 1 ? "" : "s"} queued to the candidate.`,
      );
    },
    onError: (err) => {
      setResult(null);
      setError(err.message);
    },
  });

  // The catalogue reads are gated to admin / hr_head, while the push is gated
  // to the onboarding roles. A recruiter or hr_ops caller therefore gets a
  // FORBIDDEN here — say so plainly rather than showing an empty picker.
  const readForbidden = [tracksQuery.error, resourcesQuery.error].some(
    (e) => e instanceof TRPCClientError && e.data?.code === "FORBIDDEN",
  );
  const readFailed = (tracksQuery.isError || resourcesQuery.isError) && !readForbidden;

  const tracks = tracksQuery.data?.rows ?? [];
  const resources = resourcesQuery.data?.rows ?? [];
  const selectedTrack = tracks.find((t) => t.id === trackId) ?? null;
  const loading = tracksQuery.isLoading || resourcesQuery.isLoading;

  const trackOptions = [
    { value: NO_TRACK, label: "No track — individual resources only" },
    ...tracks.map((t) => ({
      value: t.id,
      label: `${t.name} · ${LEARNING_TRACK_LAYER_LABELS[t.layer]} · ${t.items.length} item${
        t.items.length === 1 ? "" : "s"
      }`,
    })),
  ];

  // Resources already carried by the chosen track are not offered loose — the
  // bundle is the stronger statement and the server would dedupe them anyway.
  const inTrack = new Set(selectedTrack?.items.map((i) => i.resourceId) ?? []);
  const pickable = resources.filter((r) => !r.isArchived && !inTrack.has(r.id));

  const trackMinutes = selectedTrack
    ? totalMinutes(
        selectedTrack.items.map((i) => ({
          estimatedMinutes: resources.find((r) => r.id === i.resourceId)?.estimatedMinutes ?? null,
        })),
      )
    : 0;

  const pushCount = (selectedTrack?.items.length ?? 0) + picked.size;

  function toggle(id: string) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function push() {
    setError(null);
    setResult(null);
    const resourceIds = [...picked];
    if (trackId === NO_TRACK && resourceIds.length === 0) {
      setError("Pick a track, at least one resource, or both.");
      return;
    }
    assign.mutate({
      caseId,
      ...(trackId === NO_TRACK ? {} : { trackId }),
      ...(resourceIds.length > 0 ? { resourceIds } : {}),
    });
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-neutral-800">Learning &amp; development</h3>
        <Button
          variant={open ? "ghost" : "secondary"}
          size="sm"
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
            setResult(null);
          }}
        >
          {open ? "Close" : "Assign learning"}
        </Button>
      </div>

      <Card>
        {result ? (
          <p className="mb-3 rounded-md bg-status-success-50 px-3 py-2 text-sm text-status-success-700">
            {result}
          </p>
        ) : null}
        {error ? (
          <p className="mb-3 rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
            {error}
          </p>
        ) : null}

        {!open ? (
          <p className="text-sm text-neutral-500">
            Push a curated track and/or individual resources at this hire. Each one becomes a task
            on the checklist above and the candidate is notified.
          </p>
        ) : loading ? (
          <p className="text-sm text-neutral-500">Loading the learning catalogue…</p>
        ) : readForbidden ? (
          <EmptyState
            className="py-8"
            title="Your role can't read the learning catalogue"
            hint="Pushing learning is an onboarding action, but the catalogue itself is admin / HR-head configuration. Ask an administrator to push it, or to grant you access."
          />
        ) : readFailed ? (
          <EmptyState
            className="py-8"
            title="We couldn't load the learning catalogue"
            hint="Try again in a moment."
          />
        ) : resources.length === 0 && tracks.length === 0 ? (
          <EmptyState
            className="py-8"
            title="Nothing to assign yet"
            hint="No learning has been configured for this tenant. An admin or HR head sets up the catalogue and tracks under Admin → Learning."
          />
        ) : (
          <div className="space-y-4">
            <div>
              <span className="mb-1 block text-[11px] font-medium text-neutral-500">Track</span>
              <Select
                size="sm"
                options={trackOptions}
                value={trackId}
                onValueChange={(v) => setTrackId(v)}
              />
              {selectedTrack ? (
                selectedTrack.items.length === 0 ? (
                  <p className="mt-2 text-xs text-neutral-500">
                    This track has no items — it would push nothing.
                  </p>
                ) : (
                  <ol className="mt-2 space-y-1">
                    {selectedTrack.items.map((i, idx) => (
                      <li
                        key={i.resourceId}
                        className="flex flex-wrap items-center gap-2 text-xs text-neutral-600"
                      >
                        <span className="tabular-nums text-neutral-400">{idx + 1}.</span>
                        <span className="text-neutral-800">{i.resourceTitle}</span>
                        <span className="text-neutral-400">
                          {providerLabel(i.resourceProvider)}
                        </span>
                        {i.isRequired ? <Badge tone="accent">Required</Badge> : null}
                        {i.dueOffsetDays == null ? null : (
                          <span className="text-neutral-500">
                            due day {i.dueOffsetDays} after start
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )
              ) : null}
              {selectedTrack ? (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                  <Badge tone={layerTone(selectedTrack.layer)}>
                    {LEARNING_TRACK_LAYER_LABELS[selectedTrack.layer]}
                  </Badge>
                  {trackMinutes > 0 ? <>≈{formatMinutes(trackMinutes)} of learning</> : null}
                </p>
              ) : null}
            </div>

            <div>
              <span className="mb-1 block text-[11px] font-medium text-neutral-500">
                Individual resources for this hire
              </span>
              {pickable.length === 0 ? (
                <p className="text-xs text-neutral-500">
                  {resources.length === 0
                    ? "The catalogue is empty."
                    : "Every catalogue resource is already in the selected track."}
                </p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-neutral-200 p-2">
                  {pickable.map((r) => (
                    <li key={r.id}>
                      <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-50">
                        <input
                          type="checkbox"
                          checked={picked.has(r.id)}
                          onChange={() => toggle(r.id)}
                          className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                        />
                        <span className="min-w-0 text-neutral-800">
                          {r.title}
                          <span className="block text-xs text-neutral-400">
                            {providerLabel(r.provider)}
                            {r.estimatedMinutes == null
                              ? ""
                              : ` · ${formatMinutes(r.estimatedMinutes)}`}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4">
              <p className="text-xs text-neutral-500">
                Pushing notifies the candidate and adds {pushCount}{" "}
                {pushCount === 1 ? "task" : "tasks"} to their checklist. Anything they already have
                is left alone, progress and all. Completion is self-attested — HireOps links to the
                material, it can&apos;t verify it was consumed.
              </p>
              <Button size="sm" disabled={assign.isPending || pushCount === 0} onClick={push}>
                {assign.isPending ? "Pushing…" : "Push to candidate"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
