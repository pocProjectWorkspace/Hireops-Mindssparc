import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Shown while a submission resolves on a client-side navigation (the first
 * paint is server-rendered with data). Mirrors the real page — header →
 * ownership banner → timeline → submitted details — so the frame holds.
 */
export default function SubmissionDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-6 h-4 w-36" />
      <Skeleton className="mb-2 h-7 w-1/2" />
      <Skeleton className="mb-6 h-4 w-2/3" />
      <Skeleton className="mb-8 h-20 w-full" />
      <Skeleton className="mb-3 h-5 w-28" />
      <SkeletonRows count={4} barClassName="h-12" />
      <Skeleton className="mb-3 mt-8 h-5 w-40" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
