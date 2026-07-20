import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { UndoToastProvider } from "@/components/triage/UndoToastProvider";
import { CandidateDetailDrawer } from "@/components/triage/CandidateDetailDrawer";
import { CandidatesByRoleList } from "@/components/recruiter/CandidatesByRoleList";
import type { TenantSourceRow } from "@hireops/api-types";

export const dynamic = "force-dynamic"; // Auth-gated + reads live pipeline state.

/**
 * RECR-02 — the recruiter's "All candidates" surface, grouped by requisition.
 * A genuine new surface (there was no grouped candidates table before). Server-
 * renders the grouped rows via listCandidatesByRequisition; the client owns
 * search / stage / source filters and the row actions. Persona-gated to
 * recruiter / admin (enforced by the API too); another role gets a calm notice.
 *
 * The existing triage CandidateDetailDrawer is reused via ?candidateId /
 * ?applicationId; UndoToastProvider wraps the tree because the row actions fire
 * advance / reject mutations with undo.
 */

const READ_ROLES = ["recruiter", "admin"];

export default async function CandidatesPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Candidates"
        isAdmin={isAdmin}
        roles={session.roles}
        active="candidates"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Candidates isn't available for your role"
          hint="This surface is for recruiters. If you need access, ask an administrator to add the recruiter role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const initial = await caller.listCandidatesByRequisition({});
  const sourcesRes = await caller
    .listTenantSources({})
    .catch(() => ({ rows: [] as TenantSourceRow[] }));

  // The registry (G04) drives the recruiter surface's source labels + filter:
  // only ENABLED channels contribute an override label and a filter option.
  const enabledSourceRows = sourcesRes.rows.filter((r) => r.enabled);
  const sourceLabels = Object.fromEntries(
    enabledSourceRows.map((r) => [r.sourceEnum, r.label] as const),
  );
  const enabledSources = enabledSourceRows.map((r) => r.sourceEnum);

  return (
    <UndoToastProvider>
      <AppShell
        title="Candidates"
        isAdmin={isAdmin}
        roles={session.roles}
        active="candidates"
        user={sessionUserChip(session)}
      >
        <CandidatesByRoleList
          initial={initial}
          sourceLabels={sourceLabels}
          enabledSources={enabledSources}
        />
        <CandidateDetailDrawer />
      </AppShell>
    </UndoToastProvider>
  );
}
