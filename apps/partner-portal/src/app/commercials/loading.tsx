import { Skeleton, SkeletonTiles, SkeletonRows } from "@/components/ui";

/**
 * Shown on a client-side navigation into /commercials (the first paint is
 * server-rendered with data). Mirrors the real page — heading, the three
 * rollup tiles, then the fee rows — so the frame doesn't jump.
 */
export default function CommercialsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <Skeleton className="mb-2 h-7 w-44" />
      <Skeleton className="mb-8 h-4 w-96" />
      <SkeletonTiles count={3} />
      <div className="mt-6">
        <SkeletonRows count={3} barClassName="h-16" />
      </div>
    </div>
  );
}
