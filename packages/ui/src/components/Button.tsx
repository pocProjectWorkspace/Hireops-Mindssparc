import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  type?: "button" | "submit" | "reset";
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  // brand-500 (#3b82f6) measures 3.67:1 on white — below the 4.5:1
  // WCAG-AA threshold for normal-weight text. Lifting the primary CTA
  // to brand-600 (5.2:1) clears axe. Hover at brand-700 (7.4:1) keeps
  // the depth cue; active reuses brand-700 because the palette stops
  // there. brand-500 stays defined in tokens.css for non-text uses
  // (focus outlines, checked indicators) where the 3:1 graphical
  // threshold applies.
  primary:
    "bg-brand-600 text-white shadow-1 hover:bg-brand-700 active:bg-brand-700 " +
    "disabled:bg-neutral-300 disabled:text-neutral-500 disabled:shadow-none",
  secondary:
    "bg-white text-neutral-700 border border-neutral-300 " +
    "hover:bg-neutral-50 hover:border-neutral-400 " +
    "active:bg-neutral-100 " +
    "disabled:bg-neutral-100 disabled:text-neutral-400 disabled:border-neutral-200",
  tertiary:
    "bg-transparent text-brand-600 " +
    "hover:bg-brand-50 " +
    "active:bg-brand-100 " +
    "disabled:text-neutral-400 disabled:bg-transparent",
  destructive:
    "bg-status-error-500 text-white hover:bg-status-error-700 " +
    "disabled:bg-neutral-300 disabled:text-neutral-500",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-2",
  md: "h-10 px-4 text-base gap-2",
  lg: "h-12 px-6 text-base gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    disabled = false,
    iconLeft,
    iconRight,
    fullWidth = false,
    type = "button",
    className,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-disabled={isDisabled || undefined}
      className={cn(
        "inline-flex items-center justify-center font-medium rounded-md",
        "transition-colors duration-150",
        "focus:outline-none focus-visible:outline focus-visible:outline-2",
        "focus-visible:outline-brand-500 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed",
        fullWidth && "w-full",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size} /> : iconLeft && <span className="shrink-0">{iconLeft}</span>}
      <span>{children}</span>
      {!loading && iconRight && <span className="shrink-0">{iconRight}</span>}
    </button>
  );
});

function Spinner({ size }: { size: ButtonSize }) {
  const dim = size === "sm" ? "h-3 w-3" : size === "lg" ? "h-5 w-5" : "h-4 w-4";
  return (
    <svg
      className={cn("animate-spin shrink-0", dim)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
    </svg>
  );
}
