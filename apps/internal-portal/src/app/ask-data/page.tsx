import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { RoleNotice } from "@/components/nav/RoleNotice";
import { AskDataClient } from "./AskDataClient";

export const dynamic = "force-dynamic"; // Role-gated + reads live hiring data.

/**
 * ASK-DATA — /ask-data, natural-language analytics.
 *
 * The AI only maps a question to one of a fixed catalog of supported
 * questions (+ period / business unit / requisition); every number is
 * computed by the API over the reporting semantic layer. The catalog (chips,
 * the tenant's business units, whether typed questions are on) is
 * server-prefetched so the chips work the moment the page lands.
 *
 * admin, hr_head, hr_ops, recruiter, hiring_manager — matching the API's
 * ASK_DATA_ROLES. A hiring manager's answers are scoped to the requisitions
 * they manage (enforced server-side).
 */

const READ_ROLES = ["admin", "hr_head", "hr_ops", "recruiter", "hiring_manager"];

export default async function AskDataPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Ask your data"
        isAdmin={isAdmin}
        roles={session.roles}
        active="ask-data"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Ask your data isn't available for your role"
          hint="This page is for HR, recruiters, hiring managers and administrators. If you need access, ask an administrator."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const catalog = await caller.askDataCatalog({});

  return (
    <AppShell
      title="Ask your data"
      isAdmin={isAdmin}
      roles={session.roles}
      active="ask-data"
      user={sessionUserChip(session)}
    >
      <AskDataClient catalog={catalog} />
    </AppShell>
  );
}
