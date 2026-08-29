import Link from "next/link";

/**
 * LEGAL-1 — platform-level footer: MindsSparc identity + legal links.
 * Rendered by every shell (not per page). The logo asset is dark-on-
 * transparent, so this footer assumes a light background.
 */
export function PlatformFooter({
  className = "",
  centered = false,
}: {
  className?: string;
  centered?: boolean;
}) {
  return (
    <footer className={`border-t border-neutral-200 px-4 py-4 sm:px-6 ${className}`}>
      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-400 ${centered ? "justify-center" : ""}`}
      >
        <img src="/logo/mindssparc-logo.png" alt="MindsSparc" className="h-5 w-auto" />
        <span>&copy; MindsSparc Pvt Ltd</span>
        <Link href="/terms" className="hover:text-neutral-600">
          Terms
        </Link>
        <Link href="/privacy" className="hover:text-neutral-600">
          Privacy
        </Link>
      </div>
    </footer>
  );
}
