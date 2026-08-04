"use client";

import { useState } from "react";
import type { ReactNode } from "react";
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
 * Assign learning to ONE hire (LD-1B; suggestions added by LD-2B) — the push.
 *
 * A recruiter decides what this hire needs and pushes it: a curated track, a
 * handful of loose catalogue resources, the suggestions derived from their own
 * skill gaps, or any combination. `assignLearningToCase`
 * materialises one ordinary onboarding task per resource (so the items land in
 * the checklist above, under "Learning & development") and enqueues one
 * candidate notification per newly-assigned resource. Suggestions go through
 * that SAME mutation — there is exactly one way learning reaches a hire, and
 * the derived half is a proposal the recruiter accepts, never an auto-assign.
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
      // Suggestions exclude what the case already carries, so anything just
      // pushed must drop out of the list rather than sit there re-offerable.
      queryClient.invalidateQueries({ queryKey: [["getSuggestedLearningForCase"]] });
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

  // One resource = one task, however it was chosen: a suggestion the recruiter
  // accepted lands in the SAME `picked` set as a loose tick (it is the same
  // resource and the same push), and the union with the track's items keeps an
  // overlap from being counted twice.
  const pushCount = new Set([...(selectedTrack?.items.map((i) => i.resourceId) ?? []), ...picked])
    .size;

  // The catalogue block has something to offer. Kept separate from the
  // suggestion block, which is gated to the ONBOARDING roles rather than the
  // admin ones and so can be readable when the catalogue is not.
  const catalogueUsable =
    !loading && !readForbidden && !readFailed && (resources.length > 0 || tracks.length > 0);

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
        {/* NOT "Learning & development" — the checklist above already has a
            group by that name (onboarding-format.ts TASK_GROUPS), and two
            identical headings on one page read as two sections rather than a
            cause and its effect. This one is named for what it DOES. */}
        <h3 className="text-sm font-semibold text-neutral-800">Assign learning</h3>
        <Button
          variant={open ? "ghost" : "secondary"}
          size="sm"
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
            setResult(null);
          }}
        >
          {open ? "Close" : "Choose items"}
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
            Push a curated track, individual resources and/or the items suggested by this
            hire&apos;s own skill gaps. Each one becomes a task on the checklist above and the
            candidate is notified.
          </p>
        ) : (
          <div className="space-y-4">
            {/* The derived half (LD-2B). Its own query, its own gate — a
                recruiter who can't read the admin catalogue can still see and
                push what this hire is missing. */}
            <SuggestionsSection caseId={caseId} enabled={open} picked={picked} onToggle={toggle} />

            {loading ? (
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
              </div>
            )}

            {pushCount > 0 || catalogueUsable ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-4">
                <p className="text-xs text-neutral-500">
                  Pushing notifies the candidate and adds {pushCount}{" "}
                  {pushCount === 1 ? "task" : "tasks"} to their checklist. Anything they already
                  have is left alone, progress and all. Completion is self-attested — HireOps links
                  to the material, it can&apos;t verify it was consumed.
                </p>
                <Button size="sm" disabled={assign.isPending || pushCount === 0} onClick={push}>
                  {assign.isPending ? "Pushing…" : "Push to candidate"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Card>
    </section>
  );
}

/**
 * "Suggested for this hire" (LD-2B) — the derived half, made visible.
 *
 * `getSuggestedLearningForCase` compares the skills this role's JD asks for
 * against the skills parsed from this person's CV when they applied, and offers
 * whatever the org has mapped to close the difference. It writes NOTHING: every
 * row here is a proposal, ticked into the same `picked` set as a loose resource
 * and pushed through the same `assignLearningToCase`. Every suggestion states
 * the skill it closes, because the whole value is that the recruiter can see
 * WHY it was suggested and overrule it.
 *
 * THE DISTINCTION THIS SECTION EXISTS TO KEEP — "we couldn't read the CV" and
 * "no gaps found" are opposite claims. The first means we have no information;
 * the second means we checked and this hire is ready. `hasParsedSkills` is the
 * flag that separates them, and conflating the two would have HireOps quietly
 * misrepresent a hire's readiness. An unparsed CV NEVER renders as "no gaps".
 *
 * Its gate is the ONBOARDING one — the same as the push, and deliberately not
 * the admin gate the catalogue reads use. A recruiter who cannot read the
 * catalogue can still see and push this hire's suggestions.
 */
function SuggestionsSection({
  caseId,
  enabled,
  picked,
  onToggle,
}: {
  caseId: string;
  enabled: boolean;
  picked: Set<string>;
  onToggle: (resourceId: string) => void;
}) {
  const query = trpc.getSuggestedLearningForCase.useQuery(
    { caseId },
    { enabled, retry: false, staleTime: 60_000 },
  );

  const forbidden =
    query.error instanceof TRPCClientError && query.error.data?.code === "FORBIDDEN";

  const heading = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        Suggested for this hire
      </span>
      <span className="text-xs text-neutral-400">
        From their CV against this role&apos;s job description
      </span>
    </div>
  );

  let body: ReactNode;

  if (query.isLoading) {
    body = <p className="mt-2 text-sm text-neutral-500">Checking this hire&apos;s skill gaps…</p>;
  } else if (forbidden) {
    // Same gate as the push, so in practice unreachable from this panel —
    // stated plainly rather than rendered as an empty (i.e. "no gaps") list.
    body = (
      <p className="mt-2 text-sm text-neutral-500">
        Your role can&apos;t read this hire&apos;s skill gaps, so there is nothing to suggest here.
      </p>
    );
  } else if (query.isError || !query.data) {
    body = (
      <p className="mt-2 text-sm text-neutral-500">
        We couldn&apos;t work out this hire&apos;s skill gaps just now — this says nothing about
        whether they have any. Try again in a moment, or pick learning yourself below.
      </p>
    );
  } else if (!query.data.hasParsedSkills) {
    // ── THE LOAD-BEARING CASE ──────────────────────────────────────────────
    // No parsed skills = no information. Saying "no gaps found" here would
    // claim we checked and this hire is ready, which is the opposite of the
    // truth and exactly the false reading the flag exists to prevent.
    body = (
      <div className="mt-2 rounded-md border border-status-warning-200 bg-status-warning-50 px-3 py-2 text-sm text-status-warning-800">
        <span className="font-medium">We couldn&apos;t read this hire&apos;s CV.</span> There are no
        parsed skills on their profile, so there was nothing to compare against this role&apos;s
        requirements. This is <span className="font-medium">not</span> the same as finding no gaps —
        we don&apos;t know either way. Re-upload their CV so it can be parsed, or pick their
        learning yourself below.
      </div>
    );
  } else if (query.data.jdSkillCount === 0) {
    body = (
      <p className="mt-2 text-sm text-neutral-500">
        This role&apos;s job description lists no skills, so there is nothing to compare their CV
        against. Add skills to the JD to get suggestions here.
      </p>
    );
  } else if (query.data.missingSkills.length === 0) {
    body = (
      <p className="mt-2 text-sm text-neutral-500">
        <span className="font-medium text-neutral-700">No gaps found.</span> Their CV evidences
        every one of the {query.data.jdSkillCount} skill
        {query.data.jdSkillCount === 1 ? "" : "s"} this role&apos;s job description lists, so there
        is nothing to suggest. You can still push a track or individual resources below.
      </p>
    );
  } else {
    const { suggestions, missingSkills } = query.data;
    // Gaps the org has nothing mapped to. Worth naming rather than hiding: it
    // is the admin's cue to add a mapping, not evidence the hire is fine.
    const unmapped = missingSkills.filter((s) => !s.hasSuggestion);
    const requiredGaps = missingSkills.filter((s) => s.isRequired).length;

    body = (
      <div className="mt-2 space-y-2">
        <p className="text-xs text-neutral-500">
          {missingSkills.length} skill{missingSkills.length === 1 ? "" : "s"} this role asks for
          {missingSkills.length === 1 ? " is" : " are"} not evidenced by their CV
          {requiredGaps > 0 ? `, ${requiredGaps} of them required` : ""}. Tick what you agree with —
          nothing is assigned until you push.
        </p>

        {suggestions.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nothing in the upskilling library closes those gaps yet.
          </p>
        ) : (
          <ul className="space-y-1 rounded-md border border-neutral-200 p-2">
            {suggestions.map((s) => (
              <li
                key={s.resourceId}
                // Required gaps carry a warning hairline as well as the tone on
                // the chip — the difference has to survive a glance.
                className={`flex items-start gap-2 rounded px-2 py-1.5 hover:bg-neutral-50 ${
                  s.isRequiredSkill ? "border-l-2 border-status-warning-300" : ""
                }`}
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.has(s.resourceId)}
                    onChange={() => onToggle(s.resourceId)}
                    className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="min-w-0 text-neutral-800">
                    {s.title}
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={s.isRequiredSkill ? "warning" : "neutral"}>
                        {s.skillName} ·{" "}
                        {s.isRequiredSkill ? "closes a required gap" : "closes a nice-to-have gap"}
                      </Badge>
                      <span className="text-xs text-neutral-400">
                        {providerLabel(s.provider)}
                        {s.estimatedMinutes == null
                          ? ""
                          : ` · ${formatMinutes(s.estimatedMinutes)}`}
                      </span>
                    </span>
                  </span>
                </label>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800"
                >
                  Open
                </a>
              </li>
            ))}
          </ul>
        )}

        {unmapped.length > 0 ? (
          <p className="text-xs text-neutral-500">
            Nothing is mapped to {unmapped.map((s) => s.skillName).join(", ")} — an admin can map a
            resource to {unmapped.length === 1 ? "it" : "them"} under Admin → Learning → Upskilling
            library.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50/50 p-3">
      {heading}
      {body}
    </div>
  );
}
