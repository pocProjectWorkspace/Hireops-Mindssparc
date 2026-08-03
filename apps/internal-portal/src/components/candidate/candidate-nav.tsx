/**
 * Candidate portal navigation config (CAND-01). The routed candidate portal's
 * sidebar items — the single source both CandidateShell (public entry that
 * delegates to the portal chrome) and CandidatePortalChrome read from.
 *
 * Kept as a hook-free data module (no "use client") so it imports cleanly into
 * both server and client files. Icons reuse the internal-portal nav-icon set
 * (16px, currentColor) plus two candidate-only marks (bell, gear) inlined to
 * the same spec — the DESIGN-01 no-new-runtime-deps fence.
 *
 * Ownership note (CAND-01 ↔ CAND-02 union seam): CAND-01 owns Dashboard,
 * Applications, Interviews and the Settings placeholder; the Profile,
 * Documents and Notifications routes are BUILT by CAND-02 — CAND-01 only wires
 * the nav LINKS here so the sidebar is whole.
 */
import type { ReactNode } from "react";
import {
  IconHome,
  IconUsers,
  IconRequisitions,
  IconInterviews,
  IconDocuments,
} from "../nav/nav-icons";

export type CandidateNavKey =
  | "dashboard"
  | "profile"
  | "applications"
  | "interviews"
  | "documents"
  | "learning"
  | "notifications"
  | "settings";

export interface CandidateNavItem {
  key: CandidateNavKey;
  label: string;
  href: string;
  icon: ReactNode;
  /** Route built by CAND-02 (link only — CAND-01 does not own the page body). */
  external?: boolean;
}

/** Bell — Notifications. 16px / 1.75 stroke, matches nav-icons. */
function IconBell() {
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
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.5 21a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

/** Open book — Learning (LD-1B). 16px / 1.75 stroke, matches nav-icons. */
function IconBook() {
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
      <path d="M12 7C10.5 5.6 8.6 5 6 5H3v12h3c2.6 0 4.5.6 6 2" />
      <path d="M12 7c1.5-1.4 3.4-2 6-2h3v12h-3c-2.6 0-4.5.6-6 2z" />
      <line x1="12" y1="7" x2="12" y2="19" />
    </svg>
  );
}

/** Gear — Settings. 16px / 1.75 stroke, matches nav-icons. */
function IconGear() {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export const CANDIDATE_NAV: CandidateNavItem[] = [
  { key: "dashboard", label: "Dashboard", href: "/candidate", icon: <IconHome /> },
  {
    key: "profile",
    label: "My Profile",
    href: "/candidate/profile",
    icon: <IconUsers />,
    external: true,
  },
  {
    key: "applications",
    label: "Applications",
    href: "/candidate/applications",
    icon: <IconRequisitions />,
  },
  {
    key: "interviews",
    label: "Interviews",
    href: "/candidate/interviews",
    icon: <IconInterviews />,
  },
  {
    key: "documents",
    label: "Documents",
    href: "/candidate/documents",
    icon: <IconDocuments />,
    external: true,
  },
  {
    // LD-1B: the learning a recruiter has pushed onto this hire's onboarding
    // case — grouped by layer, each item an outbound link plus a self-attested
    // progress control.
    key: "learning",
    label: "Learning",
    href: "/candidate/learning",
    icon: <IconBook />,
  },
  {
    key: "notifications",
    label: "Notifications",
    href: "/candidate/notifications",
    icon: <IconBell />,
    external: true,
  },
  { key: "settings", label: "Settings", href: "/candidate/settings", icon: <IconGear /> },
];
