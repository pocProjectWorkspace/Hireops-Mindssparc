/**
 * Token mirror. Source of truth is tokens.css; this file mirrors it for
 * programmatic access. If you change a value here without changing it in
 * tokens.css (or vice versa), tests will catch the drift.
 */

export const colors = {
  neutral: {
    50: "#fafafa",
    100: "#f5f5f5",
    200: "#e5e5e5",
    300: "#d4d4d4",
    400: "#a3a3a3",
    500: "#737373",
    600: "#525252",
    700: "#404040",
    800: "#262626",
    900: "#171717",
  },
  brand: {
    50: "#eff6ff",
    100: "#dbeafe",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
  },
  status: {
    positive: { 50: "#f0fdf4", 500: "#22c55e", 700: "#15803d" },
    warning: { 50: "#fffbeb", 500: "#f59e0b", 700: "#b45309" },
    error: { 50: "#fef2f2", 500: "#ef4444", 700: "#b91c1c" },
    info: { 50: "#eff6ff", 500: "#3b82f6" },
  },
  partnerAccent: { 50: "#fff7ed", 500: "#ea580c" },
  ai: {
    surface: "#faf5ff",
    border: "#e9d5ff",
    accent: "#7c3aed",
  },
} as const;

export const fontFamily = {
  ui: "'Inter', system-ui, -apple-system, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
} as const;

export const fontSize = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  md: "1.125rem",
  lg: "1.25rem",
  xl: "1.5rem",
  "2xl": "1.875rem",
  "3xl": "2.25rem",
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const lineHeight = {
  tight: 1.25,
  normal: 1.5,
  relaxed: 1.75,
} as const;

export const spacing = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  10: "2.5rem",
  12: "3rem",
  16: "4rem",
  20: "5rem",
  24: "6rem",
} as const;

export const elevation = {
  1: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  2: "0 4px 6px -1px rgb(0 0 0 / 0.10), 0 2px 4px -2px rgb(0 0 0 / 0.10)",
  3: "0 20px 25px -5px rgb(0 0 0 / 0.10), 0 8px 10px -6px rgb(0 0 0 / 0.10)",
} as const;

export const radius = {
  sm: "0.25rem",
  md: "0.5rem",
  lg: "0.75rem",
  full: "9999px",
} as const;

export const zIndex = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  overlay: 300,
  modal: 400,
  toast: 500,
} as const;
