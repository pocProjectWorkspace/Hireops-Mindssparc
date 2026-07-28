"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { humanizeSentence } from "@/lib/labels";
import type { ApplicationStage } from "@hireops/api-types";

/**
 * IrisApplicationPicker (IRIS-B1) — the shared candidate/application search-select
 * behind the three Pipeline/Onboarding actions. It resolves an APPLICATION id
 * (the target every one of those actions mutates) from a candidate name.
 *
 * Backed by the REAL `listCandidates` read procedure (the triage feed): it
 * returns one row per (candidate, application) with the candidate name, the
 * application id, and the current stage, and is readable by every persona that
 * can open the Iris drawer (admin + hiring_manager). We filter by typed name on
 * the client over the first page — a demo-scale, friction-free picker with no
 * new query.
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

  const query = trpc.listCandidates.useQuery({ pagination: { limit: 100 } }, { enabled });
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);

  // Pre-select from page context exactly once, when the rows first arrive.
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
        fullName: match.fullName,
        stage: match.stage,
      });
    }
  }, [rows, preselectApplicationId, value, onChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q ? rows.filter((r) => (r.fullName ?? "").toLowerCase().includes(q)) : rows;
    return base.slice(0, 40);
  }, [rows, search]);

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
          placeholder="Search by candidate name…"
          className="mt-1 h-10 w-full rounded-button border border-neutral-300 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none"
        />
      </label>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white">
        {query.isLoading ? (
          <p className="px-3 py-4 text-sm text-neutral-500">Loading candidates…</p>
        ) : query.error ? (
          <p className="px-3 py-4 text-sm text-status-error-700">Couldn&apos;t load candidates.</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-4 text-sm text-neutral-500">
            {rows.length === 0 ? "No candidates found." : "No candidates match your search."}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {filtered.map((r) => (
              <li key={r.applicationId}>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      applicationId: r.applicationId,
                      candidateId: r.candidateId,
                      fullName: r.fullName,
                      stage: r.stage,
                    })
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-50"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-neutral-800">
                    {r.fullName ?? "(no name on file)"}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {humanizeSentence(r.stage)}
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
