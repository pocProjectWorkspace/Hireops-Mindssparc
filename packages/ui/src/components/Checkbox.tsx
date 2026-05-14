import { forwardRef, useId } from "react";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { cn } from "../lib/utils";

export interface CheckboxProps {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean | "indeterminate") => void;
  label?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  className?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    checked,
    defaultChecked,
    onCheckedChange,
    label,
    hint,
    error,
    disabled = false,
    required = false,
    name,
    value,
    id,
    className,
  },
  ref,
) {
  const reactId = useId();
  const controlId = id ?? `checkbox-${reactId}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasError = Boolean(error);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2">
        <RadixCheckbox.Root
          ref={ref}
          id={controlId}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          required={required}
          name={name}
          value={value}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : hint ? hintId : undefined}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border bg-white",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 focus-visible:outline-offset-2",
            "data-[state=checked]:bg-brand-500 data-[state=checked]:border-brand-500 data-[state=checked]:text-white",
            "data-[state=indeterminate]:bg-brand-500 data-[state=indeterminate]:border-brand-500 data-[state=indeterminate]:text-white",
            "disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:border-neutral-200",
            hasError ? "border-status-error-500" : "border-neutral-300 hover:border-neutral-400",
          )}
        >
          <RadixCheckbox.Indicator className="inline-flex">
            {checked === "indeterminate" ? <DashIcon /> : <CheckIcon />}
          </RadixCheckbox.Indicator>
        </RadixCheckbox.Root>
        {label && (
          <label
            htmlFor={controlId}
            className={cn(
              "select-none text-sm text-neutral-700",
              disabled && "text-neutral-400 cursor-not-allowed",
            )}
          >
            {label}
            {required && (
              <span className="ml-1 text-status-error-500" aria-hidden="true">
                *
              </span>
            )}
          </label>
        )}
      </div>

      {hasError ? (
        <p id={errorId} className="ml-6 text-sm text-status-error-700">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="ml-6 text-sm text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
    </svg>
  );
}
