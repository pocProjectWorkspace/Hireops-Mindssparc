import { Skeleton } from "@/components/ui";

/**
 * Shown while the server component previews the invitation. Mirrors the real
 * card's shape (heading → details → attestations → button) so the frame
 * doesn't jump when the content lands.
 */
export default function AcceptInviteLoading() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-lg">
        <Skeleton className="mx-auto mb-6 h-9 w-44" />
        <div className="rounded-card border border-neutral-200 bg-white p-6 shadow-card">
          <Skeleton className="mb-3 h-6 w-3/4" />
          <Skeleton className="mb-6 h-4 w-full" />
          <Skeleton className="mb-3 h-10 w-full" />
          <Skeleton className="mb-3 h-10 w-full" />
          <Skeleton className="mb-6 h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </main>
  );
}
