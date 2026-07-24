import { redirect } from "next/navigation";
import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RetentionPolicyClient } from "./RetentionPolicyClient";

export const dynamic = "force-dynamic"; // Gated + reads live tenant config.

/**
 * Admin document-retention policy (T4.3) — the per-document-type retention
 * config + the honest "documents past retention" register.
 *
 * Retention today drove NOTHING (document_types.retention_years was a displayed
 * number). This page lets a tenant set a per-type-`code` override (plus a
 * default-years fallback) that GENUINELY drives a real computation: the overdue
 * register (listDocumentsPastRetention) flags UPLOADED documents whose retention
 * period has elapsed — lowering a type's retention surfaces more overdue docs,
 * raising it removes them. An unconfigured tenant resolves to the reference
 * retention_years, so it behaves exactly as before.
 *
 * HONESTY: erasure/deletion is OUT of scope and a MANUAL process — this surface
 * NEVER deletes or anonymises a document (no delete button); it is an honest
 * register, stated as such in the UI.
 *
 * Gated to {admin, hr_head} — retention is HR-head/compliance territory alongside
 * admin. Double-gated: this redirect AND the get/updateRetentionPolicy +
 * listDocumentsPastRetention procedures (GOVERNANCE_READ_ROLES) enforce the same
 * roles server-side.
 */
export default async function RetentionPolicyPage() {
  const session = await requireAuth();
  if (!session.roles.includes("admin") && !session.roles.includes("hr_head")) {
    redirect("/triage");
  }
  const caller = createServerTRPCCaller(session);
  const [policy, retention, overdue] = await Promise.all([
    caller.getRetentionPolicy({}),
    caller.getDocumentRetention({}),
    caller.listDocumentsPastRetention({}),
  ]);

  return (
    <AppShell
      title="Retention policy"
      isAdmin
      active="retention-policy"
      user={sessionUserChip(session)}
    >
      <RetentionPolicyClient
        initialPolicy={policy}
        initialRetention={retention}
        initialOverdue={overdue}
      />
    </AppShell>
  );
}
