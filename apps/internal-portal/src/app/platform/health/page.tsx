import { PLATFORM_QUEUE_KEYS } from "@hireops/api-types";
import { requirePlatformOperator } from "@/lib/auth";
import { createPlatformServerTRPCCaller } from "@/lib/trpc-server";
import { PlatformShell, TenantStatusBadge } from "@/components/platform/PlatformShell";
import { Card, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * C1-F10 — cross-tenant operational health: queue backlogs and 7-day failures
 * per tenant (counts only) and the worker scheduled-job heartbeat.
 */
export default async function PlatformHealthPage() {
  const op = await requirePlatformOperator();
  const caller = createPlatformServerTRPCCaller(op.userId);
  const [me, health] = await Promise.all([caller.platformWhoami(), caller.platformGetHealth()]);

  return (
    <PlatformShell title="Health" active="health" operator={me}>
      <p className="mb-4 text-xs text-neutral-500">
        Generated {health.generatedAt.replace("T", " ").slice(0, 19)} UTC. Cells show backlog /
        failed in the last 7 days. Rows of non-active tenants are held (not worked) until the tenant
        is reactivated.
      </p>
      <TableShell>
        <Thead>
          <Th>Tenant</Th>
          {PLATFORM_QUEUE_KEYS.map((q) => (
            <Th key={q} numeric>
              {q.replace(/_/g, " ")}
            </Th>
          ))}
        </Thead>
        <Tbody>
          {health.tenants.map((t) => (
            <Tr key={t.tenantId}>
              <Td label="Tenant">
                <span className="mr-2 font-medium">{t.displayName}</span>
                <TenantStatusBadge status={t.status} />
              </Td>
              {t.queues.map((q) => (
                <Td key={q.queue} label={q.queue} numeric>
                  <span className={q.backlog > 0 ? "font-medium text-neutral-900" : ""}>
                    {q.backlog}
                  </span>
                  {" / "}
                  <span className={q.failed7d > 0 ? "font-medium text-status-error-700" : ""}>
                    {q.failed7d}
                  </span>
                </Td>
              ))}
            </Tr>
          ))}
        </Tbody>
      </TableShell>

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">Worker scheduled jobs (heartbeat)</h2>
        {health.jobs.length === 0 ? (
          <p className="text-sm text-neutral-500">No scheduled job has run yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 text-sm">
            {health.jobs.map((j) => (
              <li key={j.jobName} className="flex flex-wrap gap-x-4 py-2">
                <span className="font-medium">{j.jobName}</span>
                <span className="text-neutral-600">
                  last run {j.lastRunAt.replace("T", " ").slice(0, 16)} UTC
                </span>
                <span
                  className={
                    j.lastRunStatus === "ok" ? "text-neutral-600" : "text-status-error-700"
                  }
                >
                  {j.lastRunStatus}
                </span>
                {j.lastRunDurationMs !== null ? (
                  <span className="text-neutral-400">{j.lastRunDurationMs} ms</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PlatformShell>
  );
}
