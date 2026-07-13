import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * Card — a flat white surface with a 1px hairline border and an 8px radius.
 * No shadow by default (elevation is reserved for genuinely floating
 * surfaces — drawers, popovers). `padded` toggles the standard 20px inset;
 * turn it off when the card wraps its own edge-to-edge table or list.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}

export function Card({ padded = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn("rounded-md border border-neutral-200 bg-white", padded && "p-5", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
