import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/**
 * Covers client-side navigations into /admin/interview-templates — the page
 * itself is a server component so a direct load arrives with data.
 */
export default function InterviewTemplatesLoading() {
  return (
    <AppShellSkeleton title="Interview templates">
      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <SkeletonRows count={6} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
