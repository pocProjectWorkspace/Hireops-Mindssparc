import { requireAdmin, sessionUserChip } from "@/lib/auth";
import { createServerTRPCCaller } from "@/lib/trpc-server";
import { AppShell } from "@/components/nav/AppShell";
import { EmailTemplatesClient } from "./EmailTemplatesClient";

export const dynamic = "force-dynamic"; // Admin-gated + reads live tenant config.

/**
 * Admin Email templates (T1.4 / G09) — tenant copy overrides.
 *
 * Every transactional email ships code-owned copy; an org had no way to change
 * any wording. This page is that config surface: per template, an admin can
 * override the SUBJECT and each NAMED TEXT SLOT (heading, greeting, body
 * paragraphs, sign-off, footer). Layout, styles, and DATA bindings (candidate
 * name, position, dates, references, links, the .ics) stay code-owned — there
 * is deliberately no raw-HTML editor. A template with no enabled override renders
 * byte-identically to the shipped default.
 *
 * Admin-gated twice: requireAdmin (page redirect) AND the procedures
 * (getEmailTemplateCatalog / upsert / reset / preview enforce the admin role
 * server-side). Server-prefetches the catalog so the editor lands populated.
 */
export default async function EmailTemplatesPage() {
  const session = await requireAdmin();
  const caller = createServerTRPCCaller(session);
  const initial = await caller.getEmailTemplateCatalog({});

  return (
    <AppShell
      title="Email templates"
      isAdmin
      active="email-templates"
      user={sessionUserChip(session)}
    >
      <EmailTemplatesClient initial={initial} />
    </AppShell>
  );
}
