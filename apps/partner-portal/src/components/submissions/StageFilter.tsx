"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent } from "react";
import { PARTNER_STAGE_OPTIONS, stageLabel } from "./submission-format";

/**
 * The wireflows' §3.7 "All stages ▾" control. Changing it navigates to
 * /submissions?stage=… — the filter is applied by the API
 * (partnerListMySubmissions' `stage` input), not by hiding rows in the
 * browser, so a filtered list is a real query and the `capped` note it renders
 * stays truthful.
 *
 * Wrapped in a plain GET form so it still works with JavaScript off: the
 * select posts to /submissions either way, and the router.push is only the
 * no-click nicety on top.
 */
export function StageFilter({ value }: { value: string | null }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setPending(true);
    router.push(next ? `/submissions?stage=${encodeURIComponent(next)}` : "/submissions");
  }

  return (
    <form method="get" action="/submissions" className="flex items-center gap-2">
      <label htmlFor="stage" className="text-sm text-neutral-500">
        Stage
      </label>
      <select
        id="stage"
        name="stage"
        defaultValue={value ?? ""}
        onChange={onChange}
        disabled={pending}
        className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 disabled:opacity-60"
      >
        <option value="">All stages</option>
        {PARTNER_STAGE_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {stageLabel(s)}
          </option>
        ))}
      </select>
      {/* Only ever seen without JS — the onChange navigates otherwise. */}
      <noscript>
        <button
          type="submit"
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-700"
        >
          Apply
        </button>
      </noscript>
    </form>
  );
}
