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

export function IconHome() {
  return (
    <Svg>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </Svg>
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

export function IconOnboarding() {
  return (
    <Svg>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M16 11l2 2 4-4" />
    </Svg>
  );
}

export function IconOffboarding() {
  return (
    <Svg>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M17 8l4 4-4 4" />
      <line x1="21" y1="12" x2="13" y2="12" />
    </Svg>
  );
}

export function IconInterviews() {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <path d="M9 15l2 2 4-4" />
    </Svg>
  );
}

export function IconPanel() {
  return (
    <Svg>
      <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 3 1" />
      <rect x="14" y="13" width="7" height="8" rx="1.5" />
      <path d="M16.5 17l1 1 2-2" />
    </Svg>
  );
}

export function IconRequisitions() {
  return (
    <Svg>
      <path d="M8 4h9a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8" />
      <path d="M8 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2" />
      <line x1="11" y1="9" x2="16" y2="9" />
      <line x1="11" y1="13" x2="16" y2="13" />
    </Svg>
  );
}

export function IconReqApprovals() {
  return (
    <Svg>
      <path d="M9 4h6a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2" />
      <path d="M9 14l2 2 4-4" />
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

export function IconGovernance() {
  return (
    <Svg>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9.5 12l2 2 3.5-3.5" />
    </Svg>
  );
}

export function IconExecAudit() {
  return (
    <Svg>
      <path d="M12 3v3" />
      <path d="M5 7h14" />
      <path d="M7 7l-3 6a3 3 0 0 0 6 0z" />
      <path d="M17 7l-3 6a3 3 0 0 0 6 0z" />
      <path d="M12 6v13" />
      <path d="M8 21h8" />
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

export function IconMetrics() {
  return (
    <Svg>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3 3 5-7" />
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

export function IconAiSettings() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <path d="M5 5l2.2 2.2M16.8 16.8L19 19M19 5l-2.2 2.2M7.2 16.8L5 19" />
    </Svg>
  );
}

export function IconUsers() {
  return (
    <Svg>
      <path d="M16 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M9 21v-2a4 4 0 0 1 4-4h-2a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

export function IconMarketIntel() {
  return (
    <Svg>
      <path d="M3 3v18h18" />
      <path d="M7 14l3-4 3 2 4-6" />
      <circle cx="20" cy="6" r="1" />
    </Svg>
  );
}

export function IconFeasibility() {
  return (
    <Svg>
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M12 12l5-5" />
      <path d="M12 7v5h5" opacity="0" />
      <path d="M12 8v4l3 2" />
    </Svg>
  );
}

export function IconHrCases() {
  return (
    <Svg>
      <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M14 4v5h5" />
      <path d="M8 13h6" />
      <path d="M8 17h4" />
    </Svg>
  );
}

export function IconHrRounds() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
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
