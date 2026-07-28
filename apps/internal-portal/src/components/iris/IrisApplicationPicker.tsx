"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { humanizeSentence } from "@/lib/labels";
import type { ApplicationStage } from "@hireops/api-types";

/**
 * IrisApplicationPicker (IRIS-B1 / B1.1) — the shared candidate/application
 * search-select behind the three Pipeline/Onboarding actions. It resolves an
 * APPLICATION id (the target every one of those actions mutates) from a
 * candidate name or position.
 *
 * Backed by the purpose-built `irisSearchApplications` read (IRIS-B1.1): it is
 * gated to the UNION of the pipeline action roles (admin + recruiter +
 * hiring_manager + hr_ops + people_ops), so it works for EVERY persona that can
 * run one of these actions through Iris — unlike the old `listCandidates` feed,
 * which is admin/hiring_manager triage-scoped and 403'd recruiters/HR-ops. It
 * returns the application id + candidate name + position title + current stage,
 * searched server-side by the typed query.
 *
 * If the page context already names an application (entityType "application"),
 * the drawer passes it as `preselectApplicationId` and we select it once on
 * load — the user can still change it.
 */

export interface IrisPickedApplication {
  applicationId: string;
  candidateId: string;
  fullName: string | null;
  stage: ApplicationStage;
}

export function IrisApplicationPicker({
  value,
  onChange,
  enabled,
  preselectApplicationId,
}: {
  value: IrisPickedApplication | null;
  onChange: (picked: IrisPickedApplication | null) => void;
  enabled: boolean;
  preselectApplicationId?: string;
}) {
  const [search, setSearch] = useState("");

  const query = trpc.irisSearchApplications.useQuery(
    { query: search.trim() || undefined, limit: 40 },
    { enabled },
  );
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);

  // Pre-select from page context exactly once, when matching rows first arrive.
  const preselectApplied = useRef(false);
  useEffect(() => {
    if (preselectApplied.current) return;
    if (value || !preselectApplicationId || rows.length === 0) return;
    const match = rows.find((r) => r.applicationId === preselectApplicationId);
    if (match) {
      preselectApplied.current = true;
      onChange({
        applicationId: match.applicationId,
        candidateId: match.candidateId,
        fullName: match.candidateName,
        stage: match.currentStage,
      });
    }
  }, [rows, preselectApplicationId, value, onChange]);

  if (value) {
    return (
      <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-brand-900">
              {value.fullName ?? "(no name on file)"}
            </p>
            <p className="text-xs text-brand-700/80">
              Current stage: {humanizeSentence(value.stage)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="shrink-0 rounded-button px-2 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-neutral-800">
        Candidate
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by candidate name or role…"
          className="mt-1 h-10 w-full rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none"
        />
      </label>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="px-3 py-4 text-sm text-neutral-500">Loading candidates…</p>
        ) : query.error ? (
          <p className="px-3 py-4 text-sm text-status-error-700">Couldn&apos;t load candidates.</p>
        ) : rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-neutral-500">
            {search.trim() ? "No candidates match your search." : "No candidates found."}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {rows.map((r) => (
              <li key={r.applicationId}>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      applicationId: r.applicationId,
                      candidateId: r.candidateId,
                      fullName: r.candidateName,
                      stage: r.currentStage,
                    })
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-neutral-800">
                      {r.candidateName ?? "(no name on file)"}
                    </span>
                    {r.positionTitle ? (
                      <span className="block truncate text-xs text-neutral-500">
                        {r.positionTitle}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {humanizeSentence(r.currentStage)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
