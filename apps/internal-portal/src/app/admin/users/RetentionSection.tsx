import type { DocumentRetentionRow } from "@hireops/api-types";
import { Card } from "@/components/ui";
import { TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";

/**
 * Read-only Data-retention reference (CONF-03). Renders the ONBOARD-01
 * document_types reference rows (retention years per geography). READ-ONLY
 * this ticket — enforcement automation (actually deleting/anonymising expired
 * documents) is a future work package, stated honestly in the copy. Server
 * component: no interactivity, so no client bundle.
 */
export function RetentionSection({ items }: { items: DocumentRetentionRow[] }) {
  const geoLabel = (code: string | null) =>
    code === null
      ? "All geographies"
      : code === "IN"
        ? "India (IN)"
        : code === "PH"
          ? "Philippines (PH)"
          : code;

  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-neutral-900">Data retention</h2>
      <p className="mt-1 max-w-prose text-sm text-neutral-600">
        Statutory retention periods per document type, by geography — the reference data that will
        drive DPDPA-aligned retention. This view is read-only: automated enforcement (deleting or
        anonymising documents past their retention window) is a future work package, not yet wired.
      </p>

      <Card className="mt-4 p-0">
        <TableShell className="border-0">
          <Thead>
            <Th>Document type</Th>
            <Th>Geography</Th>
            <Th>Lifecycle stage</Th>
            <Th numeric>Retention (years)</Th>
          </Thead>
          <Tbody>
            {items.length === 0 ? (
              <Tr>
                <Td colSpan={4} className="text-neutral-500">
                  No document types configured.
                </Td>
              </Tr>
            ) : (
              items.map((r) => (
                <Tr key={r.code}>
                  <Td>
                    <span className="font-medium text-neutral-800">{r.name}</span>
                    <span className="ml-2 font-mono text-xs text-neutral-400">{r.code}</span>
                  </Td>
                  <Td>{geoLabel(r.geographyCode)}</Td>
                  <Td className="text-neutral-600">{r.requiredForLifecycleStage ?? "—"}</Td>
                  <Td numeric className="tabular-nums">
                    {r.retentionYears ?? "—"}
                  </Td>
                </Tr>
              ))
            )}
          </Tbody>
        </TableShell>
      </Card>
    </section>
  );
}
