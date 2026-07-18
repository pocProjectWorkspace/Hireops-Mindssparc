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
        // Full 50–900 ramps for brand + every status family. DESIGN-01
        // established the complete ramps in tokens.css so any tint/shade a
        // surface reaches for resolves — the old partial maps (brand 50–700,
        // status 50/500/700) silently compiled missing steps to nothing
        // (untinted tiles, invisible bars). Never re-introduce a partial map.
        brand: {
          50: "var(--color-brand-50)",
          100: "var(--color-brand-100)",
          200: "var(--color-brand-200)",
          300: "var(--color-brand-300)",
          400: "var(--color-brand-400)",
          500: "var(--color-brand-500)",
          600: "var(--color-brand-600)",
          700: "var(--color-brand-700)",
          800: "var(--color-brand-800)",
          900: "var(--color-brand-900)",
        },
        "status-positive": {
          50: "var(--color-status-positive-50)",
          100: "var(--color-status-positive-100)",
          200: "var(--color-status-positive-200)",
          300: "var(--color-status-positive-300)",
          400: "var(--color-status-positive-400)",
          500: "var(--color-status-positive-500)",
          600: "var(--color-status-positive-600)",
          700: "var(--color-status-positive-700)",
          800: "var(--color-status-positive-800)",
          900: "var(--color-status-positive-900)",
        },
        "status-warning": {
          50: "var(--color-status-warning-50)",
          100: "var(--color-status-warning-100)",
          200: "var(--color-status-warning-200)",
          300: "var(--color-status-warning-300)",
          400: "var(--color-status-warning-400)",
          500: "var(--color-status-warning-500)",
          600: "var(--color-status-warning-600)",
          700: "var(--color-status-warning-700)",
          800: "var(--color-status-warning-800)",
          900: "var(--color-status-warning-900)",
        },
        "status-error": {
          50: "var(--color-status-error-50)",
          100: "var(--color-status-error-100)",
          200: "var(--color-status-error-200)",
          300: "var(--color-status-error-300)",
          400: "var(--color-status-error-400)",
          500: "var(--color-status-error-500)",
          600: "var(--color-status-error-600)",
          700: "var(--color-status-error-700)",
          800: "var(--color-status-error-800)",
          900: "var(--color-status-error-900)",
        },
        "status-info": {
          50: "var(--color-status-info-50)",
          100: "var(--color-status-info-100)",
          200: "var(--color-status-info-200)",
          300: "var(--color-status-info-300)",
          400: "var(--color-status-info-400)",
          500: "var(--color-status-info-500)",
          600: "var(--color-status-info-600)",
          700: "var(--color-status-info-700)",
          800: "var(--color-status-info-800)",
          900: "var(--color-status-info-900)",
        },
        // DESIGN-05 dark application chrome (PartnerShell top bar).
        sidebar: {
          DEFAULT: "var(--color-sidebar-bg)",
          elevated: "var(--color-sidebar-elevated)",
          border: "var(--color-sidebar-border)",
          fg: "var(--color-sidebar-fg)",
          "fg-muted": "var(--color-sidebar-fg-muted)",
          active: "var(--color-sidebar-active-bg)",
          "active-fg": "var(--color-sidebar-active-fg)",
          accent: "var(--color-sidebar-accent)",
        },
        // DESIGN-05 muted-metallic score tiers.
        tier: {
          "gold-bg": "var(--color-tier-gold-bg)",
          "gold-fg": "var(--color-tier-gold-fg)",
          "gold-border": "var(--color-tier-gold-border)",
          "silver-bg": "var(--color-tier-silver-bg)",
          "silver-fg": "var(--color-tier-silver-fg)",
          "silver-border": "var(--color-tier-silver-border)",
          "platinum-bg": "var(--color-tier-platinum-bg)",
          "platinum-fg": "var(--color-tier-platinum-fg)",
          "platinum-border": "var(--color-tier-platinum-border)",
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
        button: "var(--radius-button)",
        md: "var(--radius-md)",
        card: "var(--radius-card)",
        lg: "var(--radius-lg)",
        full: "var(--radius-full)",
      },
      // Elevation wired from the tokens. Flat cards use a 1px hairline; the
      // DESIGN-05 `card` level is the soft resting lift; levels 2/3 stay for
      // genuinely floating surfaces (drawers, menus).
      boxShadow: {
        1: "var(--elevation-1)",
        2: "var(--elevation-2)",
        3: "var(--elevation-3)",
        card: "var(--elevation-card)",
      },
      backgroundImage: {
        "sidebar-brand": "var(--gradient-sidebar-brand)",
      },
    },
  },
  plugins: [],
};

export default config;
