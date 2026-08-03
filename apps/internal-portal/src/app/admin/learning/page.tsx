import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { LearningClient } from "./LearningClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin Learning & development (LD-1B) — the tenant's L&D configuration.
 *
 * HireOps ORCHESTRATES learning, it does not author or host it. Two configs:
 *  (A) Catalogue — `learning_resources`, a library of POINTERS: a Workday
 *      Learning / LinkedIn Learning / Cornerstone deep link, a SharePoint or
 *      Drive doc, an unlisted video, a Confluence page. `url` IS the payload;
 *      there is no upload here and there never will be — that is authoring.
 *  (B) Tracks — `learning_tracks`, curated bundles: one 'organisation'
 *      induction layer, and 'role' tracks bound to a position or a role family.
 *
 * Neither config reaches a hire on its own. A recruiter PUSHES a track and/or
 * loose resources onto ONE onboarding case from the case detail surface
 * (assignLearningToCase), which materialises ordinary onboarding tasks and
 * notifies the candidate.
 *
 * Gated to the WRITE roles (admin + hr_head) — the comp-bands / sla-thresholds
 * shape. Double-gated: this redirect AND the procedures themselves
 * (LEARNING_ADMIN_ROLES server-side). Server-prefetches both lists, including
 * archived resources and inactive tracks, so the surface lands populated.
 */
export default async function LearningPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const [resources, tracks] = await Promise.all([
    caller.listLearningResources({ includeArchived: true }),
    caller.listLearningTracks({ includeInactive: true }),
  ]);

  return (
    <AppShell title="Learning" isAdmin active="learning" user={sessionUserChip(session)}>
      <LearningClient initialResources={resources} initialTracks={tracks} />
    </AppShell>
  );
}
