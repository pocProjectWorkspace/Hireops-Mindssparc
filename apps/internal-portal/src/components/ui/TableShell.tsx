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
 *
 * RESPONSIVE (mobile): below `lg` the table collapses to stacked cards — the
 * header row is hidden, each row becomes a bordered card, and each cell becomes
 * a full-width block. Pass `label` to a `Td` and that column's name renders
 * above the value on mobile (a definition-list read); the label is hidden at
 * `lg`+ where the real header row returns. Cells are `block` (not flex) on
 * mobile, so multi-element cells (avatar + name, chip rows) keep their layout —
 * they just gain a label line. No per-table change is required for the card
 * layout itself; labels are progressive polish.
 */
export function TableShell({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className={cn(
        "lg:overflow-x-auto lg:rounded-card lg:border lg:border-neutral-200 lg:bg-white lg:shadow-card",
        className,
      )}
      {...rest}
    >
      <table className="block w-full text-sm lg:table">{children}</table>
    </div>
  );
}

export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead className="hidden lg:table-header-group">
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
  return <tbody className="block lg:table-row-group">{children}</tbody>;
}

export function Tr({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { children: ReactNode }) {
  return (
    <tr
      className={cn(
        // Mobile: a bordered card. Desktop: a bordered table row with hover.
        "mb-3 block rounded-card border border-neutral-200 bg-white p-3 shadow-card last:mb-0",
        "lg:mb-0 lg:table-row lg:rounded-none lg:border-x-0 lg:border-b lg:border-t-0 lg:border-neutral-100 lg:bg-transparent lg:p-0 lg:shadow-none lg:last:border-0 lg:hover:bg-neutral-50",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({
  numeric = false,
  label,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  /** Column name shown above the value on mobile cards (hidden at lg+). */
  label?: string;
}) {
  return (
    <td
      className={cn(
        // Mobile: full-width block cell (label line + value). Desktop: table cell.
        "block px-0 py-1 first:pt-0 last:pb-0 lg:table-cell lg:px-4 lg:py-2.5 lg:first:pt-2.5 lg:last:pb-2.5",
        numeric ? "tabular-nums text-neutral-700 lg:text-right" : "text-neutral-800",
        className,
      )}
      {...rest}
    >
      {label ? (
        <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wider text-neutral-400 lg:hidden">
          {label}
        </span>
      ) : null}
      {children}
    </td>
  );
}
