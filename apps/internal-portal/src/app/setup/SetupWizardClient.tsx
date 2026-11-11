"use client";

import { useState } from "react";
import type { GetTenantSetupOutput, TenantSetupStepKey } from "@hireops/api-types";
import { Button, Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { PageContainer } from "@/components/nav/PageContainer";
import { trpc } from "@/lib/trpc-client";

const inputCls =
  "w-full rounded-button border border-neutral-300 bg-white px-3 h-9 text-sm text-neutral-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500";

/**
 * C1-F11 — setup wizard. Steps are a checklist the admin ticks as they finish
 * the linked admin pages; the go-live step runs the required checks
 * (admin, business unit, approval routing or explicit skip, sender name).
 */
export function SetupWizardClient({ initial }: { initial: GetTenantSetupOutput }) {
  const [state, setState] = useState(initial);
  const [senderName, setSenderName] = useState(initial.senderName ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const onDone = (s: GetTenantSetupOutput) => {
    setState(s);
    setMessage(null);
  };
  const onError = (e: { message: string }) => setMessage(e.message);
  const setStep = trpc.setTenantSetupStep.useMutation({ onSuccess: onDone, onError });
  const setSkip = trpc.setTenantSetupApprovalSkip.useMutation({ onSuccess: onDone, onError });
  const setSender = trpc.updateTenantSenderName.useMutation({ onSuccess: onDone, onError });
  const goLive = trpc.tenantGoLive.useMutation({
    onSuccess: (s) => {
      setState(s);
      setMessage("Setup complete. Your organisation is ready to hire.");
    },
    onError,
  });
  const completed = state.onboardingStatus === "completed";

  return (
    <PageContainer variant="measure">
      <PageHeader
        title="Tenant setup"
        subtitle={
          completed
            ? "Setup is complete. You can still revisit any step."
            : "Work through each step, then go live. Each step links to the page where the setting lives."
        }
      />
      {state.starterPack ? (
        <p className="mt-2 text-xs text-neutral-500">
          Started from the “{state.starterPack.key}” starter pack (version{" "}
          {state.starterPack.version}).
        </p>
      ) : null}
      <ol className="mt-6 flex flex-col gap-4">
        {state.steps.map((step, i) => (
          <li key={step.key}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">
                    {i + 1}. {step.label}{" "}
                    {step.complete ? (
                      <span className="ml-1 text-xs text-status-positive-700">Done</span>
                    ) : null}
                  </h2>
                  <p className="mt-1 text-sm text-neutral-600">{step.description}</p>
                  {step.links.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {step.links.map((l) => (
                        <li key={l.href + l.label}>
                          <a href={l.href} className="text-brand-700 hover:underline">
                            {l.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {step.key !== "go_live" ? (
                  <Button
                    size="sm"
                    variant={step.complete ? "ghost" : "secondary"}
                    disabled={setStep.isPending}
                    onClick={() =>
                      setStep.mutate({
                        step: step.key as Exclude<TenantSetupStepKey, "go_live">,
                        complete: !step.complete,
                      })
                    }
                  >
                    {step.complete ? "Mark not done" : "Mark done"}
                  </Button>
                ) : null}
              </div>

              {step.key === "hiring_process" ? (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={state.approvalRoutingSkipped}
                    disabled={setSkip.isPending}
                    onChange={(e) => setSkip.mutate({ skipped: e.target.checked })}
                  />
                  Skip approval routing for now (approvals go to the HR head)
                </label>
              ) : null}

              {step.key === "communications" ? (
                <form
                  className="mt-3 flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setSender.mutate({ senderName: senderName.trim() || null });
                  }}
                >
                  <label className="min-w-[16rem] flex-1 text-sm">
                    <span className="mb-1 block text-neutral-700">
                      Sender name on candidate email (the address stays the platform&apos;s)
                    </span>
                    <input
                      className={inputCls}
                      maxLength={80}
                      value={senderName}
                      onChange={(e) => setSenderName(e.target.value)}
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={setSender.isPending}>
                    Save
                  </Button>
                </form>
              ) : null}

              {step.key === "go_live" ? (
                <div className="mt-3">
                  <ul className="mb-3 flex flex-col gap-1 text-sm">
                    {state.checks.map((c) => (
                      <li key={c.key} className="flex gap-2">
                        <span
                          className={c.ok ? "text-status-positive-700" : "text-status-error-700"}
                        >
                          {c.ok ? "✓" : "✗"}
                        </span>
                        <span>
                          {c.label} <span className="text-neutral-500">— {c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!completed ? (
                    <Button
                      size="sm"
                      disabled={!state.canGoLive || goLive.isPending}
                      onClick={() => goLive.mutate({})}
                    >
                      Go live
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ol>
      {message ? (
        <p role="status" className="mt-4 text-sm text-neutral-700">
          {message}
        </p>
      ) : null}
    </PageContainer>
  );
}
