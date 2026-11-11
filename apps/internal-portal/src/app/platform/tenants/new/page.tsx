import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { createPlatformServerTRPCCaller } from "@/lib/trpc-server";
import { PlatformShell } from "@/components/platform/PlatformShell";
import { CreateTenantForm } from "./CreateTenantForm";

export const dynamic = "force-dynamic";

/**
 * C1-F11 — create a tenant from a starter pack. Write-role operators only
 * (platformWriteProcedure refuses `support` server-side as well).
 */
export default async function CreateTenantPage() {
  const op = await requirePlatformOperator();
  const caller = createPlatformServerTRPCCaller(op.userId);
  const [me, { packs }] = await Promise.all([
    caller.platformWhoami(),
    caller.platformListStarterPacks(),
  ]);
  if (!me.canWrite) redirect("/platform");
  return (
    <PlatformShell title="Create tenant" active="tenants" operator={me}>
      <CreateTenantForm packs={packs} />
    </PlatformShell>
  );
}
