import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

/**
 * Portal-local Button — the DESIGN-01 house button. Small, typed,
 * className-composable. Four intents, two sizes. 6px radius (--radius-button),
 * accent = brand only on the primary intent; everything else stays neutral so
 * colour reads as meaning, not decoration.
 *
 * (Kept portal-local this phase; promoting to @hireops/ui is a later refactor.
 * The existing @hireops/ui Button remains for surfaces already wired to it.)
 */
export type PortalButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type PortalButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: PortalButtonVariant;
  size?: PortalButtonSize;
  iconLeft?: ReactNode;
  type?: "button" | "submit" | "reset";
}

const VARIANTS: Record<PortalButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white shadow-1 hover:bg-brand-700 active:bg-brand-800 " +
    "disabled:bg-neutral-300 disabled:text-neutral-500 disabled:shadow-none",
  secondary:
    "bg-white text-neutral-700 border border-neutral-300 shadow-1 hover:bg-neutral-50 " +
    "hover:border-neutral-400 active:bg-neutral-100 " +
    "disabled:bg-neutral-100 disabled:text-neutral-400 disabled:border-neutral-200 disabled:shadow-none",
  ghost:
    "bg-transparent text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 " +
    "active:bg-neutral-200 disabled:text-neutral-400 disabled:bg-transparent",
  danger:
    "bg-status-error-600 text-white shadow-1 hover:bg-status-error-700 active:bg-status-error-800 " +
    "disabled:bg-neutral-300 disabled:text-neutral-500 disabled:shadow-none",
};

const SIZES: Record<PortalButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", iconLeft, type = "button", className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-button font-medium",
        "transition-colors duration-150 focus:outline-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
        "disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {iconLeft ? <span className="shrink-0">{iconLeft}</span> : null}
      {children}
    </button>
  );
});
