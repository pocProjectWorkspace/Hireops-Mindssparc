"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IrisAvatar } from "@/components/iris/IrisAvatar";
import { useIrisControls } from "@/components/iris/IrisProvider";
import { trpc } from "@/lib/trpc-client";
import { humanize } from "@/lib/labels";
import {
  MAIN_NAV,
  ADMIN_NAV,
  MAIN_NAV_SECTIONS,
  ADMIN_NAV_SECTIONS,
  type NavItem,
} from "@/components/nav/AppShell";

const STEPS = 4;

/**
 * Iris's first-person intro per role. Warm + specific, so the welcome reads like
 * a guide talking to this person, not a feature list.
 */
const ROLE_INTRO: Record<string, { title: string; blurb: string }> = {
  recruiter: {
    title: "Your recruiting cockpit",
    blurb:
      "From the first application to a signed offer, this is where you move candidates forward. I'll handle the repetitive parts, screening nudges, stage moves, follow-ups, so you can focus on the people.",
  },
  hiring_manager: {
    title: "Your requisitions, end to end",
    blurb:
      "You open roles, shape the JD and skill weighting, and steer the candidates you care about. Tell me what you need and I'll draft, chase and organise the rest.",
  },
  hr_ops: {
    title: "Onboarding, cases and offers",
    blurb:
      "You keep joiners, documents, HR rounds and offer approvals moving. I'll open cases, request documents and route approvals whenever you ask.",
  },
  hr_head: {
    title: "Approvals and oversight",
    blurb:
      "You approve requisitions and watch hiring health across the org. I'll surface what needs your attention and keep the trail clean.",
  },
  people_ops: {
    title: "Joiners and leavers",
    blurb:
      "You run onboarding and offboarding end to end. I'll open cases and keep the process on track so nothing slips.",
  },
  panel_member: {
    title: "Your interviews",
    blurb:
      "You see the interviews assigned to you and submit structured feedback. I'll keep your schedule and scorecards in one place.",
  },
  admin: {
    title: "The whole platform",
    blurb:
      "You configure the tenant and can act across every workspace. Whatever you need done, just ask and I'll take it from there.",
  },
};

const GENERIC_INTRO = {
  title: "Welcome aboard",
  blurb:
    "Here's a quick look at your workspace and the things I can take off your plate. It only takes a minute.",
};

function pickIntro(roles: string[]) {
  const order = [
    "recruiter",
    "hiring_manager",
    "hr_ops",
    "hr_head",
    "people_ops",
    "panel_member",
    "admin",
  ];
  for (const r of order) if (roles.includes(r) && ROLE_INTRO[r]) return ROLE_INTRO[r];
  return GENERIC_INTRO;
}

/** One-line "what it's for" per nav key, so the workspace step explains, not just lists. */
const NAV_HELP: Record<string, string> = {
  home: "Your daily overview and quick actions.",
  triage: "Work the freshest applications with AI scores.",
  candidates: "Every candidate across your roles, grouped by requisition.",
  shortlist: "The AI-ranked shortlist for each open role.",
  approvals: "Pipeline approvals that are waiting on you.",
  onboarding: "Guide accepted candidates through joining.",
  offboarding: "Manage separations and final settlements.",
  "hr-cases": "HR cases, checklists and documents in one place.",
  "hr-rounds": "Schedule and run HR interview rounds.",
  requisitions: "Open, edit and manage your job requisitions.",
  "approval-tracker": "See where each requisition sits in the approval chain.",
  "skill-weighting": "Tune how candidates are scored against a role's skills.",
  "requisition-approvals": "Review and approve requisitions submitted to you.",
  "jd-library": "Every job description across your requisitions.",
  "panel-setup": "Set up interview panels and rounds for a role.",
  insights: "Hiring insights and trends for your roles.",
  metrics: "Org-wide hiring metrics and health.",
  governance: "Compliance and governance across hiring.",
  "exec-audit": "The executive audit trail of key decisions.",
  "market-intelligence": "Market and talent intelligence for planning.",
  feasibility: "Check a role's feasibility before you open it.",
  "hr-documents": "Candidate and case documents.",
  "case-audit": "The audit trail for HR cases.",
  "hr-policies": "HR policies and their rules.",
  interviews: "Scheduled interviews and their outcomes.",
  "missing-info": "Candidates missing details, ready to chase.",
  panel: "The interviews assigned to you.",
  "panel-board": "All interviews across the panel.",
  "panel-feedback": "Submit and review interview feedback.",
  "panel-history": "Your past interviews and scorecards.",
  "comp-offers": "Compensation and offer management.",
  "hr-analytics": "HR analytics and reporting.",
  workflows: "Configure automated hiring workflows.",
  branding: "Theme, logo and brand for your tenant.",
  audit: "The full platform audit log.",
  costs: "AI and platform cost tracking.",
  "ai-settings": "Configure AI features, models and Iris.",
  users: "Users, roles and access.",
  reports: "Build and export reports.",
  integrations: "Connect external systems.",
  sources: "Candidate source channels.",
  "bias-shield": "Bias detection and anonymisation controls.",
  messaging: "Messaging templates and channels.",
  "system-setup": "Core tenant configuration.",
  "approval-routing": "Who approves what, and in what order.",
  "email-templates": "Email templates for candidate comms.",
  "candidate-fields": "Custom candidate fields.",
  "interview-templates": "Reusable interview templates.",
  "business-units": "Business units and org structure.",
  "comp-bands": "Compensation bands by role and level.",
  "panel-pools": "Interviewer pools for panels.",
  "sla-thresholds": "SLA hours per pipeline stage.",
  "governance-policy": "Governance and compliance rules.",
  "retention-policy": "Data retention rules.",
};

/** Per-action explanation + an example prompt, so the Iris step feels human + concrete. */
const ACTION_HELP: Record<string, { description: string; example: string }> = {
  create_requisition_jd: {
    description: "Open a new role and I'll draft the job description for you.",
    example: "Create a Senior Backend Engineer role, hybrid, 2 openings",
  },
  advance_application: {
    description: "Move a candidate to the next stage of the pipeline.",
    example: "Advance Priya Nair to the tech interview",
  },
  reject_application: {
    description: "End a candidate's application, with the reason on record.",
    example: "Reject Rahul Verma, not enough backend depth",
  },
  open_onboarding_case: {
    description: "Start onboarding for a candidate who has accepted.",
    example: "Open an onboarding case for Aarav Shah",
  },
  bulk_advance_applications: {
    description: "Move everyone at a stage forward in one go, you confirm the exact set.",
    example: "Advance everyone in recruiter review on the Backend role",
  },
  bulk_reject_applications: {
    description: "Reject everyone at a stage at once, you confirm the exact set.",
    example: "Reject everyone still in AI screening on the Backend role",
  },
  message_candidate: {
    description: "I draft an email from the candidate's real context; you edit and send.",
    example: "Message Kavya that she's through to the final round",
  },
  hold_requisition: {
    description: "Pause hiring on a role, with a reason on the trail.",
    example: "Put the Backend Engineer req on hold, budget freeze",
  },
  resume_requisition: {
    description: "Bring a paused role back to active.",
    example: "Resume the Backend Engineer req",
  },
  request_documents: {
    description: "Ask a candidate for specific documents.",
    example: "Request payslips and ID proof from Aarav",
  },
  request_offer_approval: {
    description: "Send an offer to the comp desk for approval.",
    example: "Send Kavya's offer for approval",
  },
  cancel_interview: {
    description: "Cancel a scheduled interview; the candidate is notified.",
    example: "Cancel Rahul's tech interview, panel conflict",
  },
};

interface WorkspaceGroup {
  heading?: string;
  items: NavItem[];
}

/**
 * The workspace groups this user actually sees. Mirrors the sidebar: MAIN_NAV is
 * role-gated per item; the ADMIN section is gated as a WHOLE by isAdmin (its items
 * carry no per-item roles), so we include it ONLY for admins, never for other
 * personas.
 */
function workspaceGroups(roles: string[]): WorkspaceGroup[] {
  const isAdmin = roles.includes("admin");
  const allItems = [...MAIN_NAV, ...(isAdmin ? ADMIN_NAV : [])];
  const byKey = new Map(allItems.map((i) => [i.key, i] as const));
  const visible = new Set(
    allItems.filter((i) => !i.roles || i.roles.some((r) => roles.includes(r))).map((i) => i.key),
  );
  const sections = [...MAIN_NAV_SECTIONS, ...(isAdmin ? ADMIN_NAV_SECTIONS : [])];
  return sections
    .map((s) => ({
      heading: s.heading,
      items: s.keys
        .filter((k) => visible.has(k))
        .map((k) => byKey.get(k))
        .filter((i): i is NavItem => i !== undefined),
    }))
    .filter((g) => g.items.length > 0);
}

export function OnboardingJourney({ roles, userLabel }: { roles: string[]; userLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [mounted, setMounted] = useState(false);

  const { openIris } = useIrisControls();
  const actionsQuery = trpc.irisListActions.useQuery(undefined, { enabled: open });

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      !localStorage.getItem("hireops.onboarding.v1") &&
      roles.length > 0
    ) {
      setOpen(true);
    }
  }, []);

  function finish() {
    try {
      localStorage.setItem("hireops.onboarding.v1", new Date().toISOString());
    } catch {
      // localStorage can throw in private mode; onboarding state is best-effort
    }
    setOpen(false);
    setStep(0);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") finish();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const intro = pickIntro(roles);
  // Greet by name when we have one; never show a raw email as the greeting.
  const displayName = userLabel && !userLabel.includes("@") ? userLabel : null;
  const greeting = displayName ? `Welcome, ${displayName}` : "Welcome to HireOps";

  const groups = workspaceGroups(roles);

  const actions = actionsQuery.data?.actions ?? [];
  const groupedActions = new Map<string, { id: string; label: string }[]>();
  for (const a of actions) {
    const list = groupedActions.get(a.group) ?? [];
    list.push({ id: a.id, label: a.label });
    groupedActions.set(a.group, list);
  }

  function renderStep() {
    switch (step) {
      case 0:
        return (
          <div className="flex flex-col items-center gap-5 text-center">
            <IrisAvatar size={88} className="ring-4 ring-brand-100" />
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-neutral-900">{greeting}</h2>
              <p className="mt-1 text-sm font-medium text-brand-700">Iris, your hiring copilot</p>
            </div>
            <div className="w-full rounded-xl bg-neutral-50 p-4 text-left">
              <p className="text-sm font-semibold text-neutral-900">{intro.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{intro.blurb}</p>
            </div>
            <p className="text-xs text-neutral-400">
              This quick tour takes about a minute. You can reopen it anytime from Take the tour in
              the sidebar.
            </p>
          </div>
        );
      case 1:
        return (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">Find your way around</h2>
              <p className="mt-1 text-sm text-neutral-600">
                These are the areas you&apos;ll use most. They all live in the left sidebar, here is
                what each one is for.
              </p>
            </div>
            <div className="flex flex-col gap-5">
              {groups.map((group, idx) => (
                <div key={group.heading ?? idx}>
                  {group.heading ? (
                    <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      {group.heading}
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-3">
                    {group.items.map((item) => (
                      <li key={item.key} className="flex gap-3">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                          {item.icon}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-neutral-900">{item.label}</p>
                          {NAV_HELP[item.key] ? (
                            <p className="text-xs leading-relaxed text-neutral-500">
                              {NAV_HELP[item.key]}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="flex flex-col gap-5">
            <div className="flex items-start gap-3">
              <IrisAvatar size={40} />
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">Let me take the busywork</h2>
                <p className="mt-1 text-sm leading-relaxed text-neutral-600">
                  Open Ask Iris and tell me what you need in plain words. I draft it, you confirm,
                  then I run it, nothing happens without your OK. Here&apos;s what I can do for you:
                </p>
              </div>
            </div>
            {actionsQuery.isLoading ? (
              <p className="text-sm text-neutral-500">Loading your actions…</p>
            ) : actions.length === 0 ? (
              <p className="text-sm text-neutral-500">
                Your available actions will appear here as your access is set up.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {Array.from(groupedActions.entries()).map(([group, list]) => (
                  <div key={group}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                      {humanize(group)}
                    </p>
                    <ul className="flex flex-col gap-2.5">
                      {list.map((a) => {
                        const help = ACTION_HELP[a.id];
                        return (
                          <li key={a.id} className="rounded-lg border border-neutral-200 p-3">
                            <p className="text-sm font-medium text-neutral-900">{a.label}</p>
                            {help ? (
                              <>
                                <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
                                  {help.description}
                                </p>
                                <p className="mt-1.5 text-xs italic text-brand-700">
                                  Try: &ldquo;{help.example}&rdquo;
                                </p>
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      case 3:
        return (
          <div className="flex flex-col items-center gap-5 text-center">
            <IrisAvatar size={72} className="ring-4 ring-brand-100" />
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
                I&apos;ve got your back
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                You&apos;ll find <span className="font-medium text-brand-700">Ask Iris</span> in the
                top bar on every page. Ask me how to do something, or just tell me what you need and
                I&apos;ll take care of it, always with your confirmation.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                openIris();
                finish();
              }}
              className="rounded-button bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
            >
              Open Iris
            </button>
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setStep(0);
          setOpen(true);
        }}
        className="mt-1 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-fg-muted transition-colors hover:bg-sidebar-elevated hover:text-sidebar-fg"
      >
        <IrisAvatar size={16} />
        Take the tour
      </button>

      {open && mounted
        ? createPortal(
            <div className="fixed inset-0 z-modal flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close"
                onClick={finish}
                className="absolute inset-0 bg-neutral-900/70 backdrop-blur-sm"
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Welcome to HireOps"
                className="relative z-10 flex max-h-[86vh] w-full max-w-[34rem] flex-col overflow-hidden rounded-2xl bg-white shadow-3"
              >
                <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="text-brand-500">
                      ✨
                    </span>
                    <span className="text-sm font-semibold text-neutral-900">
                      Getting started with HireOps
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={finish}
                    className="text-sm text-neutral-500 transition-colors hover:text-neutral-900"
                  >
                    Skip
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-6">{renderStep()}</div>

                <div className="flex items-center justify-between border-t border-neutral-200 px-6 py-4">
                  <button
                    type="button"
                    disabled={step === 0}
                    onClick={() => setStep((s) => Math.max(0, s - 1))}
                    className="rounded-button px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Back
                  </button>

                  <div className="flex items-center gap-1.5" aria-hidden>
                    {Array.from({ length: STEPS }).map((_, i) => (
                      <span
                        key={i}
                        className={
                          i === step
                            ? "h-1.5 w-5 rounded-full bg-brand-600 transition-all"
                            : "h-1.5 w-1.5 rounded-full bg-neutral-300 transition-all"
                        }
                      />
                    ))}
                  </div>

                  {step < STEPS - 1 ? (
                    <button
                      type="button"
                      onClick={() => setStep((s) => Math.min(STEPS - 1, s + 1))}
                      className="rounded-button bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={finish}
                      className="rounded-button bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                    >
                      Done
                    </button>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
