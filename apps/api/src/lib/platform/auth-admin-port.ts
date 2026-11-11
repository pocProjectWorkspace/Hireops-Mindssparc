/**
 * C1-F11 — the auth-admin PORT used by tenant provisioning to invite the first
 * tenant admin.
 *
 * Provisioning never talks to Supabase directly: it calls this port, so tests
 * (and any non-Supabase deployment later) swap in a fake with
 * setAuthAdminPort(). The default implementation is Supabase's service-role
 * admin API.
 *
 * Contract — inviteUser(email, metadata):
 *   - a NEW address → an invite email is sent (Supabase inviteUserByEmail)
 *     and the new auth user carries `metadata` as user_metadata. Provisioning
 *     passes { tenant_slug, display_name }: `tenant_slug` is what the
 *     custom_access_token_hook (migration 0002) reads to pick the active
 *     tenant, so the invited admin lands in the new tenant on first sign-in.
 *   - an address that ALREADY has an auth identity → no email, no metadata
 *     change (overwriting tenant_slug would move that person's default tenant
 *     away from wherever they work today); returns alreadyExisted: true and
 *     the existing user id. They reach the new tenant through the membership
 *     provisioning creates (single-membership users are auto-selected by the
 *     hook; multi-membership users pick a tenant at sign-in).
 */

import { createClient } from "@supabase/supabase-js";

export interface AuthInviteResult {
  userId: string;
  alreadyExisted: boolean;
}

export interface AuthAdminPort {
  inviteUser(email: string, metadata: Record<string, string>): Promise<AuthInviteResult>;
}

class SupabaseAuthAdminPort implements AuthAdminPort {
  async inviteUser(email: string, metadata: Record<string, string>): Promise<AuthInviteResult> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("auth admin not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    }
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    const invited = await admin.auth.admin.inviteUserByEmail(email, {
      data: metadata,
      ...(site ? { redirectTo: `${site.replace(/\/$/, "")}/accept-invite` } : {}),
    });
    if (invited.data?.user?.id) return { userId: invited.data.user.id, alreadyExisted: false };

    // "already registered" → resolve the existing identity, change nothing.
    for (let page = 1; page <= 20; page++) {
      const list = await admin.auth.admin.listUsers({ page, perPage: 200 });
      const users = list.data?.users ?? [];
      const hit = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (hit) return { userId: hit.id, alreadyExisted: true };
      if (users.length < 200) break;
    }
    throw new Error(`auth invite failed: ${invited.error?.message ?? "unknown error"}`);
  }
}

let port: AuthAdminPort | null = null;

export function getAuthAdminPort(): AuthAdminPort {
  if (!port) port = new SupabaseAuthAdminPort();
  return port;
}

/** Swap the port (tests). Pass null to restore the Supabase default. */
export function setAuthAdminPort(next: AuthAdminPort | null): void {
  port = next;
}
