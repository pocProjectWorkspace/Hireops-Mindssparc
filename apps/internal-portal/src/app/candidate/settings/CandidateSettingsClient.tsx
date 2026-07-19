"use client";

import { Card } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";

/**
 * Candidate settings (CAND-01) — a minimal, honest placeholder. Shows the
 * account's identity (read-only) and states plainly that preference controls
 * are coming, rather than rendering non-functional toggles.
 */
export function CandidateSettingsClient() {
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });

  return (
    <CandidateShell variant="portal" active="settings">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Settings</h1>
          <p className="text-sm text-neutral-600">Your account details.</p>
        </header>

        <Card className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-neutral-900">Account</h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-neutral-500">Name</dt>
              <dd className="text-right font-medium text-neutral-900">
                {me.data?.fullName ?? "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-neutral-500">Email</dt>
              <dd className="break-all text-right font-medium text-neutral-900">
                {me.data?.email ?? "—"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-neutral-500">Employer</dt>
              <dd className="text-right font-medium text-neutral-900">
                {me.data?.tenantDisplayName ?? "—"}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="p-5">
          <p className="text-sm text-neutral-500">
            Notification preferences and password management are coming soon.
          </p>
        </Card>
      </div>
    </CandidateShell>
  );
}
