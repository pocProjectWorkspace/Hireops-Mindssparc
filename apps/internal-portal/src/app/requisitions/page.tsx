import { requireAuth, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { Badge, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { RoleNotice } from "@/components/nav/RoleNotice";

export const dynamic = "force-dynamic"; // Auth-gated + reads live requisition state.

/**
 * REQ-01 (Wave A) — the requirement-owner requisition list.
 *
 * A server-rendered skeleton: it lists the tenant's requisitions (title,
 * status, location, openings, created) via the role-gated
 * listRequisitionSummaries read. Rows are intentionally NOT clickable — a
 * requisition detail is REQ-02 territory; the footnote says so honestly
 * rather than dangling a dead link. The "New requisition" action routes to
 * an honest placeholder (/requisitions/new) until the creation wizard lands.
 *
 * Persona-gated to hiring_manager / recruiter / admin: the nav only surfaces
 * this item to those roles, and the API enforces the same set. A direct hit
 * by another role gets a calm in-shell notice instead of the error boundary.
 */

const READ_ROLES = ["hiring_manager", "recruiter", "admin"];

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "success",
  on_hold: "warning",
  posted: "info",
  filled: "success",
  cancelled: "error",
  closed: "neutral",
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** Anchor styled as the house primary button (Button renders a <button>, so a
 * link needs its own element — kept minimal + visually identical). */
function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex h-9 items-center justify-center rounded-button bg-brand-600 px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-brand-700 active:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
    >
      {children}
    </a>
  );
}

export default async function RequisitionsPage() {
  const session = await requireAuth();
  const isAdmin = session.roles.includes("admin");
  const allowed = session.roles.some((r) => READ_ROLES.includes(r));

  if (!allowed) {
    return (
      <AppShell
        title="Requisitions"
        isAdmin={isAdmin}
        roles={session.roles}
        active="requisitions"
        user={sessionUserChip(session)}
      >
        <RoleNotice
          title="Requisitions isn't available for your role"
          hint="This surface is for hiring managers and recruiters. If you need access, ask an administrator to add the hiring_manager role to your membership."
        />
      </AppShell>
    );
  }

  const caller = createServerTRPCCaller(session);
  const { rows } = await caller.listRequisitionSummaries({ limit: 50 });

  return (
    <AppShell
      title="Requisitions"
      isAdmin={isAdmin}
      roles={session.roles}
      active="requisitions"
      user={sessionUserChip(session)}
      actions={<LinkButton href="/requisitions/new">New requisition</LinkButton>}
    >
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        {rows.length === 0 ? (
          <EmptyState
            title="No requisitions yet"
            hint="When a hiring manager creates a requisition it appears here. The creation flow arrives with REQ-02 — for now, seeded requisitions show once they exist."
            action={<LinkButton href="/requisitions/new">New requisition</LinkButton>}
          />
        ) : (
          <>
            <TableShell>
              <Thead>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Location</Th>
                <Th numeric>Openings</Th>
                <Th>Created</Th>
              </Thead>
              <Tbody>
                {rows.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium text-neutral-900">{r.title ?? "Untitled role"}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                        {statusLabel(r.status)}
                      </Badge>
                    </Td>
                    <Td>{r.location ?? "—"}</Td>
                    <Td numeric>{r.openings}</Td>
                    <Td>{formatDate(r.createdAt)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </TableShell>
            <p className="mt-3 text-xs text-neutral-500">
              Rows aren&apos;t clickable yet — a requisition detail view arrives with the creation
              flow (REQ-02).
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
