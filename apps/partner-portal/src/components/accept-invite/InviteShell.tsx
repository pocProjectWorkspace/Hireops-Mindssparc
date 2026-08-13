import type { ReactNode } from "react";
import type { PartnerInvitationDeadState } from "@hireops/api-types";
import { Card } from "@/components/ui";

/**
 * The signed-out frame for /accept-invite — the same warm ground, centred
 * card and HireOps lockup as the partner login page, so a first-time invitee's
 * first screen and their every subsequent sign-in read as one product. Wider
 * than login's max-w-sm because this card carries a whole form.
 */
export function InviteShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <img
            src="/logo/hireops-mark.png"
            alt=""
            aria-hidden
            width={36}
            height={36}
            className="h-9 w-9 shrink-0 object-contain"
          />
          <span className="text-xl font-semibold tracking-tight text-neutral-900">
            HireOps <span className="font-normal text-neutral-500">Partners</span>
          </span>
        </div>
        <Card className="shadow-2" padded={false}>
          <div className="p-6">{children}</div>
        </Card>
        <p className="mt-6 text-center text-xs text-neutral-400">
          Need help? Contact your HireOps partner contact.
        </p>
      </div>
    </main>
  );
}

interface NoticeCopy {
  heading: string;
  body: string;
  showLogin: boolean;
}

/**
 * One card per dead-link state, in the invitee's language. `invalid` says as
 * little as the API does — an unmatched token tells us nothing about which
 * organisation (if any) it belonged to, so neither does this screen.
 */
const NOTICES: Record<PartnerInvitationDeadState, NoticeCopy> = {
  invalid: {
    heading: "This invitation link isn't valid",
    body: "The link may have been copied incompletely, or it was never issued. Check the full link in your invitation email, or ask your HireOps contact to send a new one.",
    showLogin: false,
  },
  expired: {
    heading: "This invitation has expired",
    body: "Invitations stay open for seven days. Ask your contact to re-issue it and you'll get a fresh link by email.",
    showLogin: false,
  },
  already_used: {
    heading: "This invitation has already been accepted",
    body: "An account was already set up with this link. Sign in with the email address the invitation was sent to.",
    showLogin: true,
  },
  revoked: {
    heading: "This invitation was withdrawn",
    body: "Your HireOps contact cancelled this invitation. If that looks wrong, ask them to issue a new one.",
    showLogin: false,
  },
};

export function InviteNotice({ state }: { state: PartnerInvitationDeadState }) {
  const copy = NOTICES[state];
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold tracking-tight text-neutral-900">{copy.heading}</h1>
      <p className="text-sm text-neutral-600">{copy.body}</p>
      {copy.showLogin && (
        <a
          href="/login"
          className="mt-1 inline-block text-sm font-medium text-brand-600 hover:text-brand-700"
        >
          Go to partner sign in →
        </a>
      )}
    </div>
  );
}
