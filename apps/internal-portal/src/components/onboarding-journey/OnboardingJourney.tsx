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
} from "@/components/nav/AppShell";

const STEPS = 4;

const ROLE_INTRO: Record<string, { title: string; blurb: string }> = {
  recruiter: {
    title: "Your recruiting cockpit",
    blurb: "You run the candidate pipeline, from triage and shortlisting through to offers.",
  },
  hiring_manager: {
    title: "Your requisitions, end to end",
    blurb: "You open roles, shape the JD and skill weighting, and steer candidates you care about.",
  },
  hr_ops: {
    title: "Onboarding and cases",
    blurb: "You manage onboarding, HR cases and rounds, documents and offer approvals.",
  },
  hr_head: {
    title: "Approvals and oversight",
    blurb: "You approve requisitions and keep an eye on hiring health across the org.",
  },
  people_ops: {
    title: "Onboarding and offboarding",
    blurb: "You handle joiners and leavers and keep people processes moving.",
  },
  panel_member: {
    title: "Your interviews",
    blurb: "You see your assigned interviews and submit structured feedback.",
  },
  admin: {
    title: "The whole platform",
    blurb: "You configure the tenant and can act across every workspace.",
  },
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
  return {
    title: "Welcome to HireOps",
    blurb: "Here's a quick tour of your workspace and what Iris can do for you.",
  };
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

  const nav = [...MAIN_NAV, ...ADMIN_NAV];
  const visibleKeys = new Set(
    nav.filter((i) => !i.roles || i.roles.some((r) => roles.includes(r))).map((i) => i.key),
  );
  const labelByKey = new Map(nav.map((i) => [i.key, i.label]));
  const sections = [...MAIN_NAV_SECTIONS, ...ADMIN_NAV_SECTIONS];

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
          <div className="flex flex-col items-center gap-4 text-center">
            <IrisAvatar size={64} />
            <h2 className="text-xl font-semibold text-neutral-900">
              Welcome{userLabel ? `, ${userLabel}` : ""}
            </h2>
            <div>
              <p className="text-base font-medium text-neutral-900">{intro.title}</p>
              <p className="mt-1 text-sm text-neutral-600">{intro.blurb}</p>
            </div>
          </div>
        );
      case 1:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-neutral-900">Here's how to get around.</h2>
            <div className="flex flex-col gap-4">
              {sections.map((section, idx) => {
                const keys = section.keys.filter((k) => visibleKeys.has(k));
                if (keys.length === 0) return null;
                return (
                  <div key={section.heading ?? idx}>
                    {section.heading ? (
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                        {section.heading}
                      </p>
                    ) : null}
                    <ul className="flex flex-col gap-1">
                      {keys.map((k) => (
                        <li key={k} className="text-sm text-neutral-700">
                          {labelByKey.get(k)}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-neutral-900">What you can ask Iris to do.</h2>
            {actionsQuery.isLoading ? (
              <p className="text-sm text-neutral-600">Loading your actions…</p>
            ) : actions.length === 0 ? (
              <p className="text-sm text-neutral-600">
                Your available actions will appear here as your access is set up.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {Array.from(groupedActions.entries()).map(([group, list]) => (
                  <div key={group}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                      {humanize(group)}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {list.map((a) => (
                        <li key={a.id} className="text-sm text-neutral-700">
                          {a.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <p className="text-sm text-neutral-600">and you can ask me to do these for you.</p>
          </div>
        );
      case 3:
        return (
          <div className="flex flex-col items-center gap-4 text-center">
            <IrisAvatar size={64} />
            <p className="text-sm text-neutral-700">
              I'm Iris. I'm always here to help you find your way, or run these actions for you.
              Just click Ask Iris whenever you need me.
            </p>
            <button
              type="button"
              onClick={() => {
                openIris();
                finish();
              }}
              className="rounded-button bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
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
            <div className="fixed inset-0 z-modal flex items-center justify-center">
              <button
                aria-label="Close"
                onClick={finish}
                className="absolute inset-0 bg-neutral-900/50"
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Welcome to HireOps"
                className="relative z-10 flex max-h-[85vh] w-[32rem] max-w-[92vw] flex-col overflow-hidden rounded-xl bg-white shadow-3"
              >
                <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
                  <p className="text-sm font-semibold text-neutral-900">Welcome to HireOps</p>
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

                  <span className="text-xs text-neutral-400">
                    Step {step + 1} of {STEPS}
                  </span>

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
                      className="rounded-button px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
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
