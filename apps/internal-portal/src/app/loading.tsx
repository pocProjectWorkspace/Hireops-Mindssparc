import { Skeleton, SkeletonRows } from "@/components/ui";

/**
 * Root fallback loader. Covers the post-sign-in redirect (`/` resolves the
 * landing page) and any route without its own loading.tsx — including the
 * candidate portal and public pages — so a slow first load shows a skeleton,
 * never a blank screen. Deliberately neutral: no staff navigation.
 */
export default function RootLoading() {
  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="mx-auto w-full max-w-5xl px-8 py-10" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        <Skeleton className="mb-6 h-8 w-64" />
        <SkeletonRows count={5} barClassName="h-14" />
      </div>
    </div>
  );
}
