import type { Config } from "tailwindcss";

/**
 * Inherits the design-token theme from packages/ui by re-declaring the
 * extend block. Reason for not importing packages/ui/tailwind.config.js
 * and spreading: tailwind 3.4 doesn't have a clean "extend another
 * config" pattern, and the token values are CSS var references that
 * just work as long as tokens.css is loaded — duplicating the theme
 * extend keeps each app's tailwind config self-contained.
 *
 * content globs cover this app's own source + packages/ui (so classes
 * used inside imported UI primitives are detected by the JIT).
 */
const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "./.storybook/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        neutral: {
          50: "var(--color-neutral-50)",
          100: "var(--color-neutral-100)",
          200: "var(--color-neutral-200)",
          300: "var(--color-neutral-300)",
          400: "var(--color-neutral-400)",
          500: "var(--color-neutral-500)",
          600: "var(--color-neutral-600)",
          700: "var(--color-neutral-700)",
          800: "var(--color-neutral-800)",
          900: "var(--color-neutral-900)",
        },
        brand: {
          50: "var(--color-brand-50)",
          100: "var(--color-brand-100)",
          500: "var(--color-brand-500)",
          600: "var(--color-brand-600)",
          700: "var(--color-brand-700)",
        },
        "status-positive": {
          50: "var(--color-status-positive-50)",
          500: "var(--color-status-positive-500)",
          700: "var(--color-status-positive-700)",
        },
        "status-warning": {
          50: "var(--color-status-warning-50)",
          500: "var(--color-status-warning-500)",
          700: "var(--color-status-warning-700)",
        },
        "status-error": {
          50: "var(--color-status-error-50)",
          500: "var(--color-status-error-500)",
          700: "var(--color-status-error-700)",
        },
      },
      fontFamily: {
        ui: "var(--font-family-ui)",
        mono: "var(--font-family-mono)",
      },
      fontSize: {
        xs: "var(--font-size-xs)",
        sm: "var(--font-size-sm)",
        base: "var(--font-size-base)",
        md: "var(--font-size-md)",
        lg: "var(--font-size-lg)",
        xl: "var(--font-size-xl)",
        "2xl": "var(--font-size-2xl)",
        "3xl": "var(--font-size-3xl)",
      },
      spacing: {
        0: "var(--space-0)",
        1: "var(--space-1)",
        2: "var(--space-2)",
        3: "var(--space-3)",
        4: "var(--space-4)",
        5: "var(--space-5)",
        6: "var(--space-6)",
        8: "var(--space-8)",
        10: "var(--space-10)",
        12: "var(--space-12)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
    },
  },
  plugins: [],
};

export default config;
