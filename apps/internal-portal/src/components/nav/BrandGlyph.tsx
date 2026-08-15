/**
 * The HireOps mark as a monochrome vector, drawn in `currentColor`.
 *
 * WHY NOT the supplied PNG. /logo/hireops-mark.png is a rendered, full-colour
 * asset whose figures are near-black navy — on the dark sidebar those vanish and
 * the whole glyph reads as a purple smudge at 28px. Deriving a white version
 * from the raster (luminance threshold, alpha masking) was tried and collapses
 * at nav size: the ring washes out and the handle disappears. A vector redraw of
 * the same idea — lens, three figures, handle — stays crisp at 28px and takes
 * its colour from the surface it sits on, so one glyph serves dark chrome and
 * light chrome alike.
 *
 * The colour lockup (/logo/hireops-lockup.png) is still the brand asset wherever
 * there is room and a light ground to sit it on — chiefly the login card.
 */
export function BrandGlyph({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15.2 15.2 20.5 20.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="6.75" cy="8.7" r="1.15" fill="currentColor" />
      <circle cx="13.25" cy="8.7" r="1.15" fill="currentColor" />
      <path d="M4.6 12.75a2.15 2.15 0 0 1 4.3 0z" fill="currentColor" />
      <path d="M11.1 12.75a2.15 2.15 0 0 1 4.3 0z" fill="currentColor" />
      <circle cx="10" cy="8.15" r="1.6" fill="currentColor" />
      <path d="M7.15 13.6a2.85 2.85 0 0 1 5.7 0z" fill="currentColor" />
    </svg>
  );
}
