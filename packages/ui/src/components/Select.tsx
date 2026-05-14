import { forwardRef, useId } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { cn } from "../lib/utils";

export type SelectSize = "sm" | "md";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  size?: SelectSize;
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  name?: string;
  id?: string;
  className?: string;
}

const triggerSizeClasses: Record<SelectSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-base",
};

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    options,
    value,
    defaultValue,
    onValueChange,
    size = "md",
    label,
    hint,
    error,
    required = false,
    disabled = false,
    placeholder = "Select…",
    name,
    id,
    className,
  },
  ref,
) {
  const reactId = useId();
  const triggerId = id ?? `select-${reactId}`;
  const hintId = `${triggerId}-hint`;
  const errorId = `${triggerId}-error`;
  const hasError = Boolean(error);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <label htmlFor={triggerId} className="text-sm font-medium text-neutral-700">
          {label}
          {required && (
            <span className="ml-1 text-status-error-500" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      <RadixSelect.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        disabled={disabled}
        required={required}
        name={name}
      >
        <RadixSelect.Trigger
          ref={ref}
          id={triggerId}
          aria-invalid={hasError || undefined}
          aria-required={required || undefined}
          aria-describedby={hasError ? errorId : hint ? hintId : undefined}
          className={cn(
            "inline-flex items-center justify-between gap-2 rounded-md border bg-white text-neutral-900",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 focus-visible:outline-offset-2",
            "data-[placeholder]:text-neutral-400",
            "disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400",
            triggerSizeClasses[size],
            hasError ? "border-status-error-500" : "border-neutral-300 hover:border-neutral-400",
          )}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon className="text-neutral-500">
            <ChevronDownIcon />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className={cn(
              "z-dropdown overflow-hidden rounded-md border border-neutral-200 bg-white shadow-2",
              "min-w-[var(--radix-select-trigger-width)]",
            )}
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((opt) => (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className={cn(
                    "relative flex cursor-pointer select-none items-center rounded-sm py-2 pl-8 pr-3 text-sm text-neutral-700",
                    "data-[highlighted]:bg-brand-50 data-[highlighted]:text-brand-700 data-[highlighted]:outline-none",
                    "data-[disabled]:pointer-events-none data-[disabled]:text-neutral-400",
                  )}
                >
                  <RadixSelect.ItemIndicator className="absolute left-2 inline-flex items-center justify-center">
                    <CheckIcon />
                  </RadixSelect.ItemIndicator>
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>

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

function ChevronDownIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
