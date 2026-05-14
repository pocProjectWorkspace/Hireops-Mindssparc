import { forwardRef, useId } from "react";
import * as RadixSwitch from "@radix-ui/react-switch";
import { cn } from "../lib/utils";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
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

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
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
  const controlId = id ?? `switch-${reactId}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasError = Boolean(error);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-3">
        <RadixSwitch.Root
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
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 focus-visible:outline-offset-2",
            "data-[state=checked]:bg-brand-500",
            "data-[state=unchecked]:bg-neutral-300",
            "disabled:cursor-not-allowed disabled:opacity-50",
            hasError && "outline outline-2 outline-status-error-500 outline-offset-2",
          )}
        >
          <RadixSwitch.Thumb
            className={cn(
              "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-1",
              "transition-transform duration-150",
              "data-[state=checked]:translate-x-5",
              "data-[state=unchecked]:translate-x-0",
            )}
          />
        </RadixSwitch.Root>
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
        <p id={errorId} className="ml-14 text-sm text-status-error-700">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="ml-14 text-sm text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
