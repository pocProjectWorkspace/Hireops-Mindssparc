import { Skeleton, SkeletonTiles, SkeletonRows } from "@/components/ui";

/**
 * Rarely shown — the dashboard is a server component so the first paint
 * arrives with data. Covers client-side navigations. Mirrors the real
 * dashboard shape (greeting → KPI tiles → req cards) so the frame stays put.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-2 h-7 w-48" />
      <Skeleton className="mb-8 h-4 w-64" />
      <SkeletonTiles count={3} className="mb-8 sm:grid-cols-3" />
      <Skeleton className="mb-3 h-5 w-56" />
      <SkeletonRows
        count={2}
        barClassName="h-40"
        className="md:grid md:grid-cols-2 md:gap-4 md:space-y-0"
      />
    </div>
  );
}
