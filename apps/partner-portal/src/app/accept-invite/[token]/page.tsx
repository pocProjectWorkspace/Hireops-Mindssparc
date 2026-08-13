import type { GetPartnerInvitationPreviewOutput } from "@hireops/api-types";
import { createPublicServerTRPCCaller } from "@/lib/trpc-server";
import { AcceptInviteForm } from "@/components/accept-invite/AcceptInviteForm";
import { InviteShell, InviteNotice } from "@/components/accept-invite/InviteShell";

// The token is in the URL and the preview is a live DB read — never prerender,
// never cache. Same reasoning as /login's force-dynamic.
export const dynamic = "force-dynamic";

/**
 * /accept-invite/<rawToken> — P0.2. The other end of invitePartnerUser: a
 * partner contact opens the emailed link, sees who invited them, sets a
 * password, and lands signed in on the dashboard.
 *
 * PUBLIC route (exempted in middleware.ts): the visitor has no session, which
 * is the entire point. The server component previews the invitation through
 * the in-process public caller so the first paint already knows whether the
 * link is live; only the form itself is a client component.
 *
 * Every non-live state gets its own calm card rather than an error boundary —
 * an expired or already-accepted link is a completely ordinary thing for a
 * human to be holding, not a fault.
 */
export default async function AcceptInvitePage({ params }: { params: { token: string } }) {
  const caller = createPublicServerTRPCCaller();
  const preview: GetPartnerInvitationPreviewOutput = await caller.getPartnerInvitationPreview({
    // Next has already URL-decoded the segment; base64url has no characters
    // that survive encoding differently, so this is the raw token verbatim.
    token: params.token,
  });

  if (preview.state === "valid") {
    return (
      <InviteShell>
        <AcceptInviteForm
          token={params.token}
          orgName={preview.orgName}
          tenantDisplayName={preview.tenantDisplayName}
          email={preview.email}
          intendedRole={preview.intendedRole}
          expiresAt={preview.expiresAt}
        />
      </InviteShell>
    );
  }

  return (
    <InviteShell>
      <InviteNotice state={preview.state} />
    </InviteShell>
  );
}
