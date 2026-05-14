import { forwardRef, useId } from "react";
import type { ReactNode } from "react";
import * as RadixRadioGroup from "@radix-ui/react-radio-group";
import { cn } from "../lib/utils";

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  orientation?: "vertical" | "horizontal";
  id?: string;
  className?: string;
  children: ReactNode;
}

export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    value,
    defaultValue,
    onValueChange,
    name,
    label,
    hint,
    error,
    required = false,
    disabled = false,
    orientation = "vertical",
    id,
    className,
    children,
  },
  ref,
) {
  const reactId = useId();
  const groupId = id ?? `radio-group-${reactId}`;
  const hintId = `${groupId}-hint`;
  const errorId = `${groupId}-error`;
  const hasError = Boolean(error);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label && (
        <span id={`${groupId}-label`} className="text-sm font-medium text-neutral-700">
          {label}
          {required && (
            <span className="ml-1 text-status-error-500" aria-hidden="true">
              *
            </span>
          )}
        </span>
      )}

      <RadixRadioGroup.Root
        ref={ref}
        id={groupId}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        name={name}
        required={required}
        disabled={disabled}
        orientation={orientation}
        aria-labelledby={label ? `${groupId}-label` : undefined}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : hint ? hintId : undefined}
        className={cn(
          "flex",
          orientation === "vertical" ? "flex-col gap-2" : "flex-row flex-wrap gap-4",
        )}
      >
        {children}
      </RadixRadioGroup.Root>

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

export interface RadioGroupItemProps {
  value: string;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export const RadioGroupItem = forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  function RadioGroupItem({ value, label, disabled = false, id, className }, ref) {
    const reactId = useId();
    const itemId = id ?? `radio-${reactId}`;
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <RadixRadioGroup.Item
          ref={ref}
          id={itemId}
          value={value}
          disabled={disabled}
          className={cn(
            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-white",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 focus-visible:outline-offset-2",
            "data-[state=checked]:border-brand-500",
            "disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:border-neutral-200",
            "border-neutral-300 hover:border-neutral-400",
          )}
        >
          <RadixRadioGroup.Indicator className="inline-flex items-center justify-center">
            <span className="h-2 w-2 rounded-full bg-brand-500" />
          </RadixRadioGroup.Indicator>
        </RadixRadioGroup.Item>
        {label && (
          <label
            htmlFor={itemId}
            className={cn(
              "select-none text-sm text-neutral-700",
              disabled && "text-neutral-400 cursor-not-allowed",
            )}
          >
            {label}
          </label>
        )}
      </div>
    );
  },
);
