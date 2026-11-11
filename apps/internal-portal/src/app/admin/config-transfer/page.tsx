import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { AppShell } from "@/components/nav/AppShell";
import { ConfigTransferClient } from "./ConfigTransferClient";

export const dynamic = "force-dynamic";

/**
 * C1-F11 — configuration export / import (Plan A §13). Admin only. Export is
 * configuration only — never people, candidates, requisitions or secrets.
 * Import is a dry-run diff first, then one transaction.
 */
export default async function ConfigTransferPage() {
  const session = await requireAdmin();
  return (
    <AppShell
      title="Configuration export / import"
      isAdmin
      active="config-transfer"
      user={sessionUserChip(session)}
    >
      <ConfigTransferClient />
    </AppShell>
  );
}
