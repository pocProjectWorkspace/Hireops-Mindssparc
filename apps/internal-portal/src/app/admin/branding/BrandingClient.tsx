"use client";

import { useMemo, useState } from "react";
import {
  HEX_COLOR_RE,
  MAX_DISPLAY_NAME_LEN,
  type GetTenantBrandingOutput,
} from "@hireops/api-types";
import { Input, Switch, Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin Theme & Branding editor (AD2).
 *
 * Two config cards + a live preview, saved as ONE updateTenantBranding
 * mutation (admin-only, audited). The company name writes the real
 * `tenants.display_name` COLUMN — the field that actually rebrands the
 * product across candidate-facing surfaces (they read `tenantDisplayName`
 * from it). The cosmetic trio (primary colour, logo URL, dark-mode default)
 * merges into `tenants.settings.branding` without touching sibling keys.
 *
 * Copy is honest about effect: the display name takes effect across
 * candidate-facing chrome immediately; the colour/logo/dark-mode form this
 * tenant's brand profile and drive the live preview below.
 */
export function BrandingClient({ initial }: { initial: GetTenantBrandingOutput }) {
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? "");
  const [darkModeDefault, setDarkModeDefault] = useState(initial.darkModeDefault);
  const [saved, setSaved] = useState<GetTenantBrandingOutput>(initial);
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateTenantBranding.useMutation({
    onSuccess: (res) => {
      const b = res.branding;
      setDisplayName(b.displayName);
      setPrimaryColor(b.primaryColor);
      setLogoUrl(b.logoUrl ?? "");
      setDarkModeDefault(b.darkModeDefault);
      setSaved(b);
      setNotice("Branding saved. The company name takes effect across the product immediately.");
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  const trimmedName = displayName.trim();
  const colorValid = HEX_COLOR_RE.test(primaryColor);
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= MAX_DISPLAY_NAME_LEN;
  const logoTrimmed = logoUrl.trim();
  const logoValid = logoTrimmed === "" || isHttpUrl(logoTrimmed);
  const valid = colorValid && nameValid && logoValid;

  const dirty = useMemo(
    () =>
      trimmedName !== saved.displayName ||
      primaryColor !== saved.primaryColor ||
      (logoTrimmed === "" ? null : logoTrimmed) !== saved.logoUrl ||
      darkModeDefault !== saved.darkModeDefault,
    [trimmedName, primaryColor, logoTrimmed, darkModeDefault, saved],
  );

  // The color picker only speaks #rrggbb; expand a #rgb shorthand for it.
  const pickerColor = colorValid ? expandHex(primaryColor) : "#4f46e5";

  function onSave() {
    if (!valid) return;
    update.mutate({
      displayName: trimmedName,
      primaryColor,
      logoUrl: logoTrimmed === "" ? null : logoTrimmed,
      darkModeDefault,
    });
  }

  function onDiscard() {
    setDisplayName(saved.displayName);
    setPrimaryColor(saved.primaryColor);
    setLogoUrl(saved.logoUrl ?? "");
    setDarkModeDefault(saved.darkModeDefault);
    setNotice(null);
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Theme & branding"
        subtitle="Customise this tenant's identity. The company name rebrands the product; colour, logo and dark-mode form the brand profile shown below."
      />

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.startsWith("Save failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Company Info */}
        <Card className="p-6">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-neutral-900">
            <PaletteBookIcon />
            Company info
          </h2>
          <p className="mb-5 text-xs text-neutral-500">
            The display name is the real tenant identity — candidate-facing pages and portal chrome
            read it. This is the field that rebrands the product.
          </p>
          <div className="space-y-4">
            <Input
              label="Company name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={MAX_DISPLAY_NAME_LEN}
              required
              error={!nameValid && displayName.length > 0 ? "Company name is required" : undefined}
              placeholder="e.g. NovaChem GCC"
            />
            <Input
              label="Logo URL"
              type="text"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              hint="Optional. An https link to a square logo image."
              error={!logoValid ? "Enter a valid URL, or leave blank" : undefined}
              placeholder="https://…"
            />
          </div>
        </Card>

        {/* Appearance */}
        <Card className="p-6">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-neutral-900">
            <PaletteIcon />
            Appearance
          </h2>
          <p className="mb-5 text-xs text-neutral-500">
            The brand colour and dark-mode default form this tenant&apos;s brand profile, previewed
            below.
          </p>
          <div className="space-y-4">
            <div>
              <span className="mb-1 block text-sm font-medium text-neutral-700">
                Primary colour
              </span>
              <div className="flex items-center gap-3">
                <label
                  className="relative h-10 w-12 shrink-0 cursor-pointer overflow-hidden rounded-md border border-neutral-300"
                  style={{ backgroundColor: colorValid ? primaryColor : "#e5e7eb" }}
                  aria-label="Pick primary colour"
                >
                  <input
                    type="color"
                    value={pickerColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
                <Input
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="flex-1"
                  aria-label="Primary colour hex"
                  error={!colorValid ? "Enter a hex colour like #4F46E5" : undefined}
                  placeholder="#4F46E5"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 pt-1">
              <div>
                <p className="text-sm font-medium text-neutral-800">Dark mode default</p>
                <p className="text-xs text-neutral-500">
                  New sessions for this tenant open in dark mode.
                </p>
              </div>
              <Switch
                checked={darkModeDefault}
                onCheckedChange={setDarkModeDefault}
                label={darkModeDefault ? "On" : "Off"}
              />
            </div>
          </div>
        </Card>
      </div>

      {/* Live preview */}
      <Card className="mt-5 p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">Live preview</h2>
          <Badge tone="neutral">{darkModeDefault ? "Dark" : "Light"}</Badge>
        </div>
        <BrandPreview
          displayName={trimmedName || "Your company"}
          primaryColor={colorValid ? primaryColor : "#9ca3af"}
          logoUrl={logoValid && logoTrimmed !== "" ? logoTrimmed : null}
          dark={darkModeDefault}
        />
      </Card>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={onSave} disabled={!dirty || !valid || update.isPending}>
          {update.isPending ? "Saving…" : "Save branding"}
        </Button>
        {dirty ? (
          <button
            type="button"
            className="text-sm text-neutral-600 hover:underline"
            onClick={onDiscard}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The branded chrome card — a faithful mock of the sidebar brand block. */
function BrandPreview({
  displayName,
  primaryColor,
  logoUrl,
  dark,
}: {
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
  dark: boolean;
}) {
  const initials = deriveInitials(displayName);
  return (
    <div
      className="flex items-center gap-3 rounded-lg border p-4"
      style={{
        borderColor: primaryColor,
        backgroundColor: dark ? "#16181f" : "#ffffff",
      }}
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="h-11 w-11 shrink-0 rounded-md object-cover"
          style={{ backgroundColor: primaryColor }}
        />
      ) : (
        <span
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-sm font-bold text-white"
          style={{ backgroundColor: primaryColor }}
        >
          {initials}
        </span>
      )}
      <div className="min-w-0">
        <p
          className="truncate text-base font-semibold"
          style={{ color: dark ? "#f4f4f5" : "#16181f" }}
        >
          {displayName}
        </p>
        <p className="truncate text-xs" style={{ color: dark ? "#a1a1aa" : "#6b7280" }}>
          Talent Acquisition Portal
        </p>
      </div>
    </div>
  );
}

function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  if (first === "") return "?";
  if (second === "") return (first.slice(0, 2) || "?").toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

/** #rgb → #rrggbb; leaves #rrggbb untouched. Assumes a valid hex input. */
function expandHex(hex: string): string {
  const match = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(hex);
  if (match) {
    const [, r, g, b] = match;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function PaletteIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="text-brand-600"
    >
      <path
        d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.4-.2-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="11" r="0.9" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="0.9" fill="currentColor" />
      <circle cx="14.5" cy="7.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function PaletteBookIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="text-brand-600"
    >
      <path
        d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path d="M4 19a2 2 0 0 0 2 2h13" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}
