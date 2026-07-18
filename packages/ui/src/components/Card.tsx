import { forwardRef } from "react";
import type { CSSProperties, ElementType, HTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../lib/utils";

export type CardVariant = "default" | "hover" | "ghost";
export type CardAs = "div" | "article" | "section" | "aside";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "style"> {
  variant?: CardVariant;
  /** Override default padding. Accepts any CSS length (e.g. "var(--space-4)", "0", "2rem"). */
  padding?: string;
  as?: CardAs;
  style?: CSSProperties;
  children: ReactNode;
}

// DESIGN-05: the elevated-card look — 10px radius + soft resting lift, with a
// hairline so cards read as layered over the warm canvas.
const variantClasses: Record<CardVariant, string> = {
  default: "bg-white border border-neutral-200 shadow-card rounded-card",
  hover:
    "bg-white border border-neutral-200 shadow-card rounded-card transition-shadow duration-150 hover:shadow-2",
  ghost: "bg-transparent rounded-card",
};

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { variant = "default", padding, as = "div", className, style, children, ...rest },
  ref,
) {
  const Component = as as ElementType;
  const mergedStyle: CSSProperties = padding !== undefined ? { ...style, padding } : (style ?? {});

  return (
    <Component
      ref={ref as Ref<HTMLElement>}
      className={cn(
        variantClasses[variant],
        // Default padding maps to --space-6 unless overridden via the `padding` prop.
        padding === undefined && "p-6",
        className,
      )}
      style={mergedStyle}
      {...rest}
    >
      {children}
    </Component>
  );
});
