import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * TableShell + primitives — the one consistent data-table look. Handles the
 * bordered, horizontally-scrollable wrapper (tables overflow inside their own
 * container, never the page); Th/Tr/Td carry the house header style, row
 * hover, cell padding (≈40px rows), and tabular-nums on numeric cells.
 *
 * Composable rather than declarative so it drops into the existing hand-rolled
 * tables (costs/reports/audit) in phase 3 with minimal edits.
 */
export function TableShell({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-card border border-neutral-200 bg-white shadow-card",
        className,
      )}
      {...rest}
    >
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-neutral-200 bg-neutral-50/60 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
        {children}
      </tr>
    </thead>
  );
}

export function Th({
  numeric = false,
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th className={cn("px-4 py-2 font-semibold", numeric && "text-right", className)} {...rest}>
      {children}
    </th>
  );
}

export function Tbody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function Tr({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr
      className={cn("border-b border-neutral-100 last:border-0 hover:bg-neutral-50", className)}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({
  numeric = false,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        "px-4 py-2.5",
        numeric ? "text-right tabular-nums text-neutral-700" : "text-neutral-800",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
