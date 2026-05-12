/**
 * Platform formatting defaults per design-system.md §2.8.
 * Tenant-overridable via tenants.settings; this is the platform fallback.
 *
 * Formatter functions (formatCurrency, formatDate, formatPhone, etc.) are
 * deferred to a later DS prompt. Components needing formatting should import
 * these defaults and use them with the formatter implementations once they exist.
 */

export const PLATFORM_DEFAULTS = {
  currency: "INR",
  currencySymbol: "₹",
  timezone: "Asia/Kolkata",
  dateFormat: "dd-MM-yyyy",
  numberFormat: "en-IN",
  phoneFormat: "IN",
  locale: "en-IN",
} as const;

export type PlatformDefaults = typeof PLATFORM_DEFAULTS;
