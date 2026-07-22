import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { CandidateFieldsClient } from "./CandidateFieldsClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Candidate fields (T2.1 / G05) — the required-candidate-field policy.
 *
 * The recruiter's Missing Info tracker classifies SEVEN known candidate-data
 * fields (each mapped to a real data source). Their requiredness and the stage a
 * missing REQUIRED field gates lived ONLY in a code constant — an org couldn't
 * say which of the seven it requires or what those requirements gate. This page
 * is that config surface: per field, a requiredness toggle + a "blocks advancement
 * to <stage>" select (or "doesn't gate"), plus reset-to-default.
 *
 * HONESTY — only these SEVEN data-backed fields are trackable (the catalog is
 * code-owned; you configure it, you cannot invent new fields). "Blocks
 * advancement" is a REAL server-side gate: a required field that is missing
 * refuses the candidate's forward move to that stage (Missing Info enforcement).
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the get/upsert/reset
 * procedures (server-side admin role).
 */
export default async function CandidateFieldsPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getCandidateFieldPolicy({});

  return (
    <AppShell
      title="Candidate fields"
      isAdmin
      active="candidate-fields"
      user={sessionUserChip(session)}
    >
      <CandidateFieldsClient initial={initial} />
    </AppShell>
  );
}
