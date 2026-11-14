import {
  PLATFORM_MODULE_KEYS,
  PLATFORM_MODULE_LABELS,
  type PlatformModuleKey,
} from "@hireops/api-types";
import { Card, Badge } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";

/**
 * C2-F7 / PP21 — a READ-ONLY view of the modules this organisation has
 * (tenant_modules, set by the platform operator in the platform console —
 * C1-F10). A tenant admin cannot switch modules here: module entitlements are
 * commercial packaging, enforced server-side. `null` = the read failed; every
 * module is treated as enabled (the platform default), and the card says so.
 */
export function ModulesCard({ modules }: { modules: Record<PlatformModuleKey, boolean> | null }) {
  return (
    <PageContainer variant="measure" className="pb-8">
      <Card className="p-6">
        <h2 className="text-base font-semibold text-neutral-900">Modules</h2>
        <p className="mt-1 text-sm text-neutral-600">
          The modules your organisation has. These are set by your HireOps platform operator;
          contact them to enable or disable a module.
        </p>
        {modules === null ? (
          <p className="mt-3 text-sm text-neutral-500">
            Module status could not be read; all modules are shown as enabled.
          </p>
        ) : null}
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {PLATFORM_MODULE_KEYS.map((k) => {
            const on = modules ? modules[k] : true;
            return (
              <li
                key={k}
                className="flex items-center justify-between rounded-lg border border-neutral-100 px-3 py-2 text-sm"
              >
                <span className="text-neutral-800">{PLATFORM_MODULE_LABELS[k]}</span>
                <Badge tone={on ? "success" : "neutral"}>{on ? "Enabled" : "Not enabled"}</Badge>
              </li>
            );
          })}
        </ul>
      </Card>
    </PageContainer>
  );
}
