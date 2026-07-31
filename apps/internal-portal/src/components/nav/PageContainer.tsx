import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * PageContainer — the single content frame every internal-portal surface renders
 * inside AppShell's <main>. Default "wide" is full-bleed edge-to-edge (the app
 * shell already fills the viewport; this just adds header-aligned horizontal
 * padding). "measure" constrains forms / single-record / reading surfaces to a
 * readable width. Horizontal padding (px-4 lg:px-8) matches the AppShell header
 * so titles and body left-align. `className` passes through per-page classes
 * (e.g. space-y-*).
 */
export function PageContainer({
  variant = "wide",
  className,
  children,
}: {
  variant?: "wide" | "measure";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "w-full px-4 py-6 lg:px-8",
        variant === "measure" && "mx-auto max-w-4xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
