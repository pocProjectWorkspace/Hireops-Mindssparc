import { AppShellSkeleton } from "@/components/nav/AppShell";
import { SkeletonRows } from "@/components/ui";

/** Covers client-side navigations into /panel/feedback. */
export default function PanelFeedbackLoading() {
  return (
    <AppShellSkeleton title="Feedback">
      <div className="mx-auto w-full max-w-4xl px-8 py-6">
        <SkeletonRows count={4} barClassName="h-16" />
      </div>
    </AppShellSkeleton>
  );
}
