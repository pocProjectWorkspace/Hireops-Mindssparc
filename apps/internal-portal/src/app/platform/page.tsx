import { requirePlatformOperator } from "@/lib/auth";
import { createPlatformServerTRPCCaller } from "@/lib/trpc-server";
import { PlatformShell, TenantStatusBadge } from "@/components/platform/PlatformShell";
import { TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * C1-F10 — platform console: the tenant registry. Operators only
 * (requirePlatformOperator + platformProcedure on the API). Metadata and
 * counts only.
 */
export default async function PlatformTenantsPage() {
  const op = await requirePlatformOperator();
  const caller = createPlatformServerTRPCCaller(op.userId);
  const [me, { items }] = await Promise.all([
    caller.platformWhoami(),
    caller.platformListTenants(),
  ]);

  return (
    <PlatformShell title="Tenants" active="tenants" operator={me}>
      {me.canWrite ? (
        <div className="mb-4">
          <a
            href="/platform/tenants/new"
            className="inline-flex rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Create tenant
          </a>
        </div>
      ) : null}
      <TableShell>
        <Thead>
          <Th>Tenant</Th>
          <Th>Status</Th>
          <Th>Tier</Th>
          <Th>Region</Th>
          <Th numeric>Active members</Th>
          <Th numeric>Active requisitions</Th>
          <Th>Modules off</Th>
        </Thead>
        <Tbody>
          {items.map((t) => (
            <Tr key={t.id}>
              <Td label="Tenant">
                <a
                  href={`/platform/tenants/${t.id}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {t.displayName}
                </a>
                <span className="ml-2 text-xs text-neutral-500">{t.slug}</span>
              </Td>
              <Td label="Status">
                <TenantStatusBadge status={t.status} />
              </Td>
              <Td label="Tier">{t.tier}</Td>
              <Td label="Region">{t.primaryRegion}</Td>
              <Td label="Active members" numeric>
                {t.activeMembers}
              </Td>
              <Td label="Active requisitions" numeric>
                {t.activeRequisitions}
              </Td>
              <Td label="Modules off">
                {t.disabledModules.length === 0 ? (
                  <span className="text-neutral-400">none</span>
                ) : (
                  t.disabledModules.join(", ")
                )}
              </Td>
            </Tr>
          ))}
        </Tbody>
      </TableShell>
      {items.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No tenants.</p> : null}
    </PlatformShell>
  );
}
