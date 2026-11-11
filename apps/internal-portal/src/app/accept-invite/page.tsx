import { AcceptInviteForm } from "./AcceptInviteForm";

export const dynamic = "force-dynamic";

/**
 * C1-F11 — public landing page for a staff invitation (the first tenant admin
 * invited by platform provisioning). Supabase's invite link signs the invitee
 * in and redirects here; the form lets them choose a password. Public route
 * (PUBLIC_PATHS) because the invitee has no password yet.
 */
export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-900">
          Welcome to HireOps
        </h1>
        <p className="mt-1 mb-6 text-sm text-neutral-500">
          Choose a password to finish setting up your account.
        </p>
        <AcceptInviteForm />
      </div>
    </main>
  );
}
