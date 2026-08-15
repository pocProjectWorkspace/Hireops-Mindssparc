import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Shown while the requisition detail resolves on a client-side navigation
 * (the first paint is server-rendered with data). Mirrors the real page —
 * header → facts card → comp → JD block → questions — so the frame holds.
 */
export default function RequisitionDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <Skeleton className="mb-2 h-7 w-2/3" />
      <Skeleton className="mb-6 h-4 w-1/2" />
      <Skeleton className="mb-8 h-24 w-full" />
      <Skeleton className="mb-2 h-5 w-40" />
      <Skeleton className="mb-8 h-20 w-full" />
      <Skeleton className="mb-2 h-5 w-40" />
      <Skeleton className="mb-8 h-56 w-full" />
      <Skeleton className="mb-3 h-5 w-44" />
      <SkeletonRows count={3} barClassName="h-14" />
    </div>
  );
}
