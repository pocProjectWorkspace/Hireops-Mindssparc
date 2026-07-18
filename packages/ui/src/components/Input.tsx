import { forwardRef, useId } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

export type InputSize = "sm" | "md";
export type InputType =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "password"
  | "search"
  | "date"
  | "datetime-local";

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix" | "type">;

export interface InputProps extends NativeInputProps {
  type?: InputType;
  size?: InputSize;
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

// TODO(DS-future): phone variant — when `type="tel"` and locale is India,
// prefix country code `+91` and apply `XX XXX XXXXX` display mask.
// design-system.md §4.2.

const frameSizeClasses: Record<InputSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-base",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    type = "text",
    size = "md",
    label,
    hint,
    error,
    required = false,
    disabled = false,
    readOnly = false,
    prefix,
    suffix,
    id,
    className,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? `input-${reactId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const hasError = Boolean(error);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-neutral-700">
          {label}
          {required && (
            <span className="ml-1 text-status-error-500" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      <div
        className={cn(
          "flex items-center gap-2 rounded-md border bg-white",
          "transition-colors duration-150",
          "focus-within:outline focus-within:outline-2 focus-within:outline-brand-500 focus-within:outline-offset-2",
          frameSizeClasses[size],
          hasError ? "border-status-error-500" : "border-neutral-300 hover:border-neutral-400",
          disabled && "bg-neutral-50 text-neutral-400 cursor-not-allowed hover:border-neutral-300",
          readOnly && !disabled && "bg-neutral-50",
        )}
      >
        {prefix && (
          <span className="shrink-0 text-neutral-500" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          type={type}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={hasError || undefined}
          aria-required={required || undefined}
          aria-describedby={hasError ? errorId : hint ? hintId : undefined}
          className={cn(
            "w-full bg-transparent text-neutral-900 placeholder:text-neutral-400",
            "outline-none border-0 p-0",
            "disabled:cursor-not-allowed disabled:text-neutral-400",
          )}
          {...rest}
        />
        {suffix && (
          <span className="shrink-0 text-neutral-500" aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>

      {hasError ? (
        <p id={errorId} className="text-sm text-status-error-700">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
