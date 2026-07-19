"use client";

import type { ReactNode } from "react";

/**
 * TabBar (HROPS-01) — a clean, reusable underline tab shell. The HR case detail
 * is the repo's first tabbed entity record; this is deliberately generic so
 * later tickets (Compensation / Offer / Documents) add a tab by appending one
 * entry to the `tabs` array. Each tab may carry an optional right-aligned badge
 * (e.g. a count or a status dot).
 */

export interface TabItem<K extends string = string> {
  key: K;
  label: string;
  badge?: ReactNode;
}

export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-neutral-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
            active === t.key
              ? "border-brand-600 text-brand-700"
              : "border-transparent text-neutral-500 hover:text-neutral-800"
          }`}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}
