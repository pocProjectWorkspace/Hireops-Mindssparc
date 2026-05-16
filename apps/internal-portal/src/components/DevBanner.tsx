/**
 * Tiny corner indicator for non-production builds. Picks NEXT_PUBLIC_ENV
 * (preferred) → falls back to NODE_ENV. Hides in production. Yellow on
 * black so it survives any theme experimentation downstream.
 *
 * Plain server component — no client state needed.
 */
export function DevBanner() {
  const env = process.env.NEXT_PUBLIC_ENV ?? process.env.NODE_ENV ?? "dev";
  if (env === "production") return null;
  return (
    <div
      role="status"
      aria-label={`Environment: ${env}`}
      className="fixed bottom-2 right-2 z-toast rounded-md bg-status-warning-500 px-2 py-1 font-mono text-xs text-neutral-900 shadow-2"
    >
      {env.toUpperCase()}
    </div>
  );
}
