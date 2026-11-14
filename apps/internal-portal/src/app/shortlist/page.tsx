import { requireAuth, sessionCan, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { UndoToastProvider } from "@/components/triage/UndoToastProvider";
import { CandidateDetailDrawer } from "@/components/triage/CandidateDetailDrawer";
import { ShortlistView } from "@/components/recruiter/ShortlistView";
import { DiverseSlateShortRoles } from "@/components/diversity/DiverseSlateShortRoles";
import { sourceLabelOverrides, type TenantSourceRow } from "@hireops/api-types";

export const dynamic = "force-dynamic"; // Auth-gated + reads live scored pipeline.

/**
 * RECR-02 — the AI Shortlist. A threshold control + three deterministic match
 * tiers over the REAL ai_score, with a ranked table carrying deterministic
 * Urgency (NOT the prototype's "Heat Score") + Risk. A genuine new surface.
 * Persona-gated to recruiter / admin. The triage CandidateDetailDrawer is
 * reused via ?candidateId; UndoToastProvider wraps it (the drawer's advance /
 * reject actions use undo).
 */

export default async function ShortlistPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = sessionCan(session, "candidates.triage");

  if (!allowed) {
    return (
      <AppShell
        title="AI Shortlist"
        isAdmin={isAdmin}
        roles={session.roles}
        active="shortlist"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Shortlist isn't available for your role"
          hint="This surface is for recruiters. If you need access, ask an administrator to add the recruiter role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  // Seed from the tenant's configured shortlist default (T2.3 / G08) — omit
  // threshold so the procedure resolves tenants.settings.shortlistDefaults.
  const initial = await caller.listShortlist({});
  // BUG-7 — the tenant's source relabels (G04 registry), as on Candidates.
  const sourcesRes = await caller
    .listTenantSources({})
    .catch(() => ({ rows: [] as TenantSourceRow[] }));
  const sourceLabels = sourceLabelOverrides(sourcesRes.rows);

  return (
    <UndoToastProvider>
      <AppShell
        title="AI Shortlist"
        isAdmin={isAdmin}
        roles={session.roles}
        active="shortlist"
        user={sessionUserChip(session)}
      >
        {/* PC-26 — roles short of their diverse slate (counts only). */}
        <DiverseSlateShortRoles variant="banner" />
        <ShortlistView
          initial={initial}
          canManageDefaults={sessionCan(session, "settings.system")}
          sourceLabels={sourceLabels}
        />
        <CandidateDetailDrawer />
      </AppShell>
    </UndoToastProvider>
  );
}
