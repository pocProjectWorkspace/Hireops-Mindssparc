import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { Badge, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { RoleNotice } from "@/components/nav/RoleNotice";

export const dynamic = "force-dynamic"; // Auth-gated + reads live approval state.

/**
 * REQ-01 (Wave A) — the HR-head requisition-approval queue.
 *
 * A server-rendered skeleton over approval_requests rows with
 * subject_type='requisition'. The table is real but empty until REQ-02/03
 * wire submission, so the honest empty state explains the flow that fills it
 * rather than pretending there's nothing to do. Decision controls
 * (approve / send-back / reject) are REQ-03 — this ticket only reads.
 *
 * Persona-gated to hr_head / admin: the nav only surfaces it to those roles
 * and the API enforces the same set (recruiter/hiring_manager get FORBIDDEN).
 * A direct hit by another role gets a calm in-shell notice.
 */

const READ_ROLES = ["hr_head", "admin"];

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "warning",
  approved: "success",
  rejected: "error",
  cancelled: "neutral",
  expired: "neutral",
};

function statusLabel(status: string): string {
  return status.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function RequisitionApprovalsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Req approvals"
        isAdmin={isAdmin}
        roles={session.roles}
        active="requisition-approvals"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Requisition approvals isn't available for your role"
          hint="This queue is for the HR head. If you need access, ask an administrator to add the hr_head role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const { rows } = await caller.listRequisitionApprovals({ limit: 50 });

  return (
    <AppShell
      title="Req approvals"
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisition-approvals"
      user={sessionUserChip(session)}
    >
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        {rows.length === 0 ? (
          <EmptyState
            title="No requisitions awaiting approval"
            hint="When a hiring manager submits a requisition for approval it lands here for the HR head to approve, send back, or reject. Submission (REQ-02) and the decision flow (REQ-03) are being built next."
          />
        ) : (
          <>
            <TableShell>
              <Thead>
                <Th>Requisition</Th>
                <Th>Status</Th>
                <Th numeric>Step</Th>
                <Th>Requested</Th>
              </Thead>
              <Tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium text-neutral-900">
                      <a
                        href={`/requisitions/${r.subjectId}`}
                        className="text-brand-700 hover:underline"
                      >
                        {r.title ?? `${r.subjectId.slice(0, 8)}…`}
                      </a>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                        {statusLabel(r.status)}
                      </Badge>
                    </Td>
                    <Td numeric>{r.currentStepIndex + 1}</Td>
                    <Td>{formatDate(r.requestedAt)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
            <p className="mt-3 text-xs text-neutral-500">
              Read-only for now — approve / send-back / reject controls arrive with REQ-03.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
