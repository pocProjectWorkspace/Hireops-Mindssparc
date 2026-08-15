import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Shown on a client-side navigation into /team (the first paint is
 * server-rendered with data). Mirrors the real page — heading, then the
 * teammate rows — so the frame doesn't jump.
 */
export default function TeamLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-2 h-7 w-40" />
      <Skeleton className="mb-8 h-4 w-80" />
      <SkeletonRows count={4} barClassName="h-16" />
    </div>
  );
}
