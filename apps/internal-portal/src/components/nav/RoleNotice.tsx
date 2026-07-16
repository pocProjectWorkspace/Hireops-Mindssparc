import { EmptyState } from "@/components/ui";

/**
 * RoleNotice (REQ-01) — the calm in-shell "this isn't for your role"
 * affordance. Used by persona-gated surfaces (/requisitions,
 * /requisition-approvals) when an authenticated user without the required
 * role lands directly on the page. We render a notice inside the shell
 * rather than redirect (the user IS signed in, just on the wrong screen)
 * or bubble the API's FORBIDDEN up to the error boundary.
 */
export function RoleNotice({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-8 py-16">
      <EmptyState title={title} hint={hint} />
    </div>
  );
}
