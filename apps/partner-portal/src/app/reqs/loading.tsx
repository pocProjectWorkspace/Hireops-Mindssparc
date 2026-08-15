import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Rarely shown — /reqs is a server component, so the first paint arrives with
 * data. Covers client-side navigations. Mirrors the real page (heading →
 * two-column card grid) so the frame doesn't jump.
 */
export default function ReqsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-2 h-7 w-64" />
      <Skeleton className="mb-8 h-4 w-80" />
      <SkeletonRows
        count={4}
        barClassName="h-44"
        className="md:grid md:grid-cols-2 md:gap-4 md:space-y-0"
      />
    </div>
  );
}
