/**
 * Minimal inline nav icons — 16px, 1.5 stroke, currentColor. Inlined (rather
 * than pulling an icon dependency) to keep the toolkit to Tailwind + React per
 * the DESIGN-01 no-new-runtime-deps fence.
 */
import type { ReactNode } from "react";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconTriage() {
  return (
    <Svg>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="14" y2="12" />
      <line x1="4" y1="18" x2="10" y2="18" />
    </Svg>
  );
}

export function IconApprovals() {
  return (
    <Svg>
      <path d="M9 12l2 2 4-4" />
      <circle cx="12" cy="12" r="9" />
    </Svg>
  );
}

export function IconWorkflows() {
  return (
    <Svg>
      <rect x="3" y="4" width="7" height="6" rx="1.5" />
      <rect x="14" y="14" width="7" height="6" rx="1.5" />
      <path d="M10 7h4a3 3 0 0 1 3 3v4" />
    </Svg>
  );
}

export function IconAudit() {
  return (
    <Svg>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </Svg>
  );
}

export function IconCosts() {
  return (
    <Svg>
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 6.5A4 4 0 0 0 13 5h-2a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-2a4 4 0 0 1-4-1.5" />
    </Svg>
  );
}

export function IconReports() {
  return (
    <Svg>
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="11" width="3" height="6" rx="0.5" />
      <rect x="11" y="7" width="3" height="10" rx="0.5" />
      <rect x="16" y="13" width="3" height="4" rx="0.5" />
    </Svg>
  );
}

export function IconIntegrations() {
  return (
    <Svg>
      <path d="M10 3v4M14 3v4" />
      <path d="M7 7h10v4a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </Svg>
  );
}

export function IconSignOut() {
  return (
    <Svg>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Svg>
  );
}
