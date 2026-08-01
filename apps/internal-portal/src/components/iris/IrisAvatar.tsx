/** Iris's avatar — a circular chip served from /iris-avatar.png. Used wherever
 * Iris appears as a PRESENCE (launcher, drawer header, onboarding). The ✨
 * sparkle stays as the separate "AI-assisted" provenance mark; it is NOT this. */
export function IrisAvatar({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/iris-avatar.png"
      alt="Iris"
      width={size}
      height={size}
      className={["shrink-0 rounded-full object-cover", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
    />
  );
}
