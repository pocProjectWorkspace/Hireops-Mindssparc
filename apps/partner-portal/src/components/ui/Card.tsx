import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * Card — the elevated white surface (DESIGN-05). A 1px hairline border, a 10px
 * radius, and a soft resting lift (`shadow-card`) so cards read as layered over
 * the warm canvas rather than one flat sheet. `padded` toggles the standard
 * 20px inset; turn it off when the card wraps its own edge-to-edge table/list.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
}

export function Card({ padded = true, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-neutral-200 bg-white shadow-card",
        padded && "p-5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
