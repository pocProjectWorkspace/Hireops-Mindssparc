import { clsx, type ClassValue } from "clsx";

/**
 * Tiny class-name composer. clsx handles conditional/array/object inputs;
 * we deliberately skip tailwind-merge here — the portal primitives don't
 * need last-wins conflict resolution, and keeping the helper dependency-light
 * keeps it usable in both server and client components.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
