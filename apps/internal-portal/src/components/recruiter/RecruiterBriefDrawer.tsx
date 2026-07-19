"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, DataBar } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type {
  RecruiterBriefKind,
  RecruiterBriefCard,
  StrengthsRisksAi,
  ScreenScriptAi,
  AvailabilityDraftAi,
} from "@hireops/api-types";

/**
 * RECR-03 — the recruiter AI Brief drawer (SHARED — owned by RECR-03; the
 * recruiter dashboard / candidate / shortlist surfaces import it). A right-side
 * slide-in matching the triage CandidateDetailDrawer chrome.
 *
 * Controlled: pass `applicationId` (null = closed) + `onClose`. It fetches the
 * whole brief via getRecruiterBrief.
 *
 * HONESTY: the candidate snapshot, the Top Skills Match (weighted resume-vs-JD
 * overlap), the Gaps / Missing Info, and the Résumé Highlights are all
 * DETERMINISTIC — no AI, and labelled as such. The three "Recruiter actions"
 * are the ONLY AI calls (feature recruiter_brief, cost-logged, kill-switchable):
 * strengths+risks, a 10-minute phone-screen script, and a DRAFT availability
 * message. The draft is a DRAFT — it is never auto-sent.
 */

const AI_ACTIONS: { kind: RecruiterBriefKind; label: string; why: string }[] = [
  {
    kind: "strengths_risks",
    label: "Summarize top 3 strengths + 2 risks vs the JD",
    why: "Quick recruiter screening reference",
  },
  {
    kind: "screen_script",
    label: "Generate a 10-minute phone-screen script",
    why: "Structured phone screen",
  },
  {
    kind: "availability_draft",
    label: "Draft a notice-period / availability message",
    why: "Draft only — you review + send",
  },
];

function SectionHeading({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
      {icon}
      {children}
    </h3>
  );
}

function statusTone(status: string): "neutral" | "warning" | "info" | "success" {
  if (status === "verified") return "success";
  if (status === "received") return "info";
  if (status === "requested") return "warning";
  return "neutral";
}

export interface RecruiterBriefDrawerProps {
  applicationId: string | null;
  onClose: () => void;
}

export function RecruiterBriefDrawer({ applicationId, onClose }: RecruiterBriefDrawerProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!applicationId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [applicationId, onClose]);

  const brief = trpc.getRecruiterBrief.useQuery(
    { applicationId: applicationId ?? "" },
    { enabled: !!applicationId },
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [["getRecruiterBrief"]] });

  const generate = trpc.generateRecruiterBrief.useMutation({ onSuccess: invalidate });
  const requestInfo = trpc.requestMissingInfo.useMutation({ onSuccess: invalidate });

  if (!applicationId) return null;

  const data = brief.data;
  const cardByKind = new Map<RecruiterBriefKind, RecruiterBriefCard>(
    (data?.briefs ?? []).map((b) => [b.kind, b]),
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recruiter AI brief"
      className="fixed inset-0 z-modal flex justify-end"
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="absolute inset-0 bg-neutral-900/40 transition-opacity"
      />
      <aside className="relative ml-auto flex h-full w-[42rem] max-w-[92vw] flex-col overflow-hidden bg-neutral-50 shadow-3">
        <header className="flex items-start justify-between gap-4 border-b border-neutral-200 bg-white px-6 py-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-neutral-900">
              <span aria-hidden className="text-brand-500">
                ✦
              </span>
              AI Brief: Candidate Snapshot
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Deterministic snapshot + skills match. AI aids are grounded, metered, and optional.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {brief.isLoading ? (
            <p className="text-sm text-neutral-500">Loading brief…</p>
          ) : brief.error ? (
            <p className="text-sm text-status-error-700">Couldn&apos;t load the brief.</p>
          ) : data ? (
            <>
              {/* Candidate overview */}
              <section className="rounded-lg border border-neutral-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-neutral-900">
                      {data.snapshot.name}
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-500">
                      {data.snapshot.roleTitle} · {data.snapshot.contextLabel}
                    </p>
                  </div>
                  {data.snapshot.source ? (
                    <Badge tone="neutral">{data.snapshot.source.replace(/_/g, " ")}</Badge>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-sm">
                  <span className="text-neutral-500">
                    AI Score:{" "}
                    <span className="font-semibold text-neutral-900">
                      {data.snapshot.aiScore != null
                        ? `${Math.round(data.snapshot.aiScore)}%`
                        : "Not scored"}
                    </span>
                  </span>
                  <span className="text-neutral-500">
                    Must-have match:{" "}
                    <span className="font-semibold text-neutral-900">
                      {data.snapshot.mustHavePct != null ? `${data.snapshot.mustHavePct}%` : "—"}
                    </span>
                  </span>
                </div>
              </section>

              {/* Top skills match (deterministic) */}
              <section className="rounded-lg border border-neutral-200 bg-white p-4">
                <SectionHeading icon={<span aria-hidden>◎</span>}>
                  Top Skills Match · résumé vs JD (deterministic)
                </SectionHeading>
                {data.skillsMatch.items.length === 0 ? (
                  <p className="text-sm text-neutral-400">No JD skills recorded for this role.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {data.skillsMatch.items.slice(0, 8).map((s, i) => (
                      <li key={i}>
                        <DataBar
                          label={
                            <span className="flex items-center gap-1.5">
                              <span className="truncate">{s.skill}</span>
                              {s.isRequired ? (
                                <Badge tone="accent" className="text-[10px]">
                                  Must-have
                                </Badge>
                              ) : null}
                            </span>
                          }
                          labelClassName="w-48 text-neutral-700"
                          pct={s.matched ? 100 : 0}
                          value={
                            <span
                              className={
                                s.matched ? "text-status-positive-700" : "text-neutral-400"
                              }
                            >
                              {s.matched ? "Match" : "Gap"}
                            </span>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-neutral-400">
                  Weighted coverage {data.skillsMatch.coveragePct}% ·{" "}
                  {data.skillsMatch.matchedCount}/{data.skillsMatch.totalCount} JD skills matched.
                  Deterministic parse match — no AI, no score cap.
                </p>
              </section>

              {/* Gaps / missing info (deterministic + real request flow) */}
              <section className="rounded-lg border border-neutral-200 bg-white p-4">
                <SectionHeading
                  icon={
                    <span aria-hidden className="text-status-warning-700">
                      ⚠
                    </span>
                  }
                >
                  Gaps / Missing Info
                </SectionHeading>
                {data.gaps.length === 0 ? (
                  <p className="text-sm text-neutral-400">No tracked fields are missing.</p>
                ) : (
                  <ul className="space-y-2">
                    {data.gaps.map((g) => (
                      <li
                        key={g.fieldKey}
                        className="flex items-center justify-between gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-800">
                            {g.fieldLabel}
                            <Badge
                              tone={g.requiredness === "required" ? "warning" : "neutral"}
                              className="text-[10px]"
                            >
                              {g.requiredness}
                            </Badge>
                          </p>
                          {g.blocksAdvanceLabel ? (
                            <p className="text-[11px] text-neutral-500">{g.blocksAdvanceLabel}</p>
                          ) : null}
                        </div>
                        {g.status === "pending" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={requestInfo.isPending}
                            onClick={() =>
                              requestInfo.mutate({ applicationId, fieldKey: g.fieldKey })
                            }
                          >
                            Request Info
                          </Button>
                        ) : (
                          <Badge tone={statusTone(g.status)}>{g.status}</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Recruiter actions (real AI) */}
              <section className="rounded-lg border border-neutral-200 bg-white p-4">
                <SectionHeading icon={<span aria-hidden>❓</span>}>
                  Recruiter actions
                </SectionHeading>
                {!data.aiEnabled ? (
                  <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
                    The recruiter AI brief is disabled for this tenant. An admin can re-enable it in
                    Admin → AI settings.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {AI_ACTIONS.map((action) => {
                      const card = cardByKind.get(action.kind);
                      const isThisPending =
                        generate.isPending && generate.variables?.kind === action.kind;
                      return (
                        <div key={action.kind} className="rounded-md border border-neutral-100 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-neutral-800">{action.label}</p>
                              <p className="text-[11px] italic text-neutral-400">{action.why}</p>
                            </div>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={generate.isPending}
                              onClick={() => generate.mutate({ applicationId, kind: action.kind })}
                            >
                              {isThisPending ? "Generating…" : card ? "Regenerate" : "Generate"}
                            </Button>
                          </div>
                          {card ? <BriefResult card={card} /> : null}
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-neutral-400">
                      Every generation is grounded in the JD + résumé, cost-logged (Admin → Costs),
                      and kill-switchable. The availability message is a DRAFT — it is never
                      auto-sent.
                    </p>
                  </div>
                )}
              </section>

              {/* Résumé highlights (deterministic) */}
              <section className="rounded-lg border border-neutral-200 bg-white p-4">
                <SectionHeading icon={<span aria-hidden>▤</span>}>Résumé Highlights</SectionHeading>
                {data.resumeHighlights.keyProjects.length === 0 &&
                data.resumeHighlights.achievements.length === 0 ? (
                  <p className="text-sm text-neutral-400">No parsed highlights on file.</p>
                ) : (
                  <div className="space-y-3">
                    {data.resumeHighlights.keyProjects.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-semibold text-neutral-700">Key projects</p>
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-neutral-600">
                          {data.resumeHighlights.keyProjects.map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {data.resumeHighlights.achievements.length > 0 ? (
                      <div>
                        <p className="mb-1 text-xs font-semibold text-neutral-700">Achievements</p>
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-neutral-600">
                          {data.resumeHighlights.achievements.map((a, i) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function BriefResult({ card }: { card: RecruiterBriefCard }) {
  if (card.kind === "strengths_risks") {
    const c = card.content as StrengthsRisksAi;
    return (
      <div className="mt-3 space-y-2 text-xs">
        <div>
          <p className="mb-1 font-semibold text-status-positive-700">Strengths</p>
          <ul className="list-disc space-y-0.5 pl-4 text-neutral-700">
            {c.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 font-semibold text-status-warning-800">Risks</p>
          <ul className="list-disc space-y-0.5 pl-4 text-neutral-700">
            {c.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (card.kind === "screen_script") {
    const c = card.content as ScreenScriptAi;
    return (
      <ol className="mt-3 space-y-2 text-xs">
        {c.sections.map((sec, i) => (
          <li key={i} className="border-l-2 border-brand-200 pl-3">
            <p className="font-semibold text-neutral-800">
              {sec.title} <span className="font-normal text-neutral-400">· {sec.minutes} min</span>
            </p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-neutral-600">
              {sec.prompts.map((p, j) => (
                <li key={j}>{p}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    );
  }
  const c = card.content as AvailabilityDraftAi;
  return (
    <div className="mt-3 rounded-md bg-neutral-50 p-3 text-xs">
      <p className="mb-1 font-semibold text-neutral-800">Subject: {c.subject}</p>
      <p className="whitespace-pre-wrap text-neutral-700">{c.body}</p>
      <p className="mt-2 text-[11px] italic text-neutral-400">
        Draft only — review and send through the normal approval path.
      </p>
    </div>
  );
}
